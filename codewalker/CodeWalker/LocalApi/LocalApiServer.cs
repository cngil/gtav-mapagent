using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SharpDX;
using CodeWalker.GameFiles;
using CodeWalker.Project;

namespace CodeWalker.LocalApi
{
    // Local HTTP API that lets the external editor app (Electron + Claude Agent SDK) drive
    // CodeWalker's world editing: search props, place/move/delete entities in the project ymap,
    // save, and position the embedded view. Listens on 127.0.0.1 only.
    //
    // Placement conventions (all relative to the camera, projected onto the ground plane):
    //   forward/right/up in meters (right < 0 is left), heading in degrees where
    //   0 = the prop's front faces the way the camera looks and 180 = it faces the camera.
    public class LocalApiServer
    {
        readonly WorldForm worldForm;
        HttpListener listener;
        CancellationTokenSource cts;
        const int Port = 35873;

        // Stable ids for entities. A ymap's entity indexes shift when entities are removed, so they
        // can't be handed out as identifiers. Only touched on the UI thread.
        readonly Dictionary<int, YmapEntityDef> entitiesById = new Dictionary<int, YmapEntityDef>();
        readonly Dictionary<YmapEntityDef, int> idsByEntity = new Dictionary<YmapEntityDef, int>();
        int nextEntityId = 1;

        // Undo history of edits made through this API. Requests carrying the same "group" (e.g. one
        // agent turn) form a single step. Only touched on the UI thread.
        class PlacedOp { public int Id; }
        class MovedOp { public int Id; public Vector3 RawPosition; public Quaternion RawRotation; }
        class DeletedOp { public int Id; public YmapEntityDef Removed; public YmapFile Ymap; }
        class HistoryStep { public string Group; public List<object> Ops = new List<object>(); }
        readonly List<HistoryStep> history = new List<HistoryStep>();
        readonly List<HistoryStep> future = new List<HistoryStep>(); // redo stack
        const int MaxHistorySteps = 200;

        // Editor-only visibility, by entity id so a prop restored by undo keeps its state. The render
        // thread reads hiddenSnapshot every frame; it is replaced wholesale, never mutated.
        readonly HashSet<int> hiddenIds = new HashSet<int>();
        volatile YmapEntityDef[] hiddenSnapshot = new YmapEntityDef[0];

        public LocalApiServer(WorldForm worldForm)
        {
            this.worldForm = worldForm;
        }

        public void Start()
        {
            listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
            listener.Start();
            cts = new CancellationTokenSource();
            Task.Run(() => AcceptLoop(cts.Token));
        }

        public void Stop()
        {
            cts?.Cancel();
            try { listener?.Stop(); } catch { }
            try { listener?.Close(); } catch { }
        }

        async Task AcceptLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                HttpListenerContext ctx;
                try
                {
                    ctx = await listener.GetContextAsync();
                }
                catch
                {
                    return; // listener was stopped/closed
                }
                _ = Task.Run(() => Handle(ctx)); // don't block the accept loop on one request
            }
        }

        void Handle(HttpListenerContext ctx)
        {
            JObject responseBody;
            int statusCode = 200;
            try
            {
                JObject requestBody = new JObject();
                if (ctx.Request.HttpMethod == "POST" && ctx.Request.HasEntityBody)
                {
                    using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
                    {
                        var text = reader.ReadToEnd();
                        if (!string.IsNullOrWhiteSpace(text))
                        {
                            requestBody = JObject.Parse(text);
                        }
                    }
                }

                switch (ctx.Request.Url.AbsolutePath)
                {
                    case "/status": responseBody = GetStatus(); break;
                    case "/embed/bounds": responseBody = SetEmbedBounds(requestBody); break;
                    case "/embed/release_focus": responseBody = ReleaseEmbedFocus(); break;
                    case "/search_props": responseBody = SearchProps(requestBody); break;
                    case "/place_entity": responseBody = PlaceEntity(requestBody); break;
                    case "/move_prop": responseBody = MoveProp(requestBody); break;
                    case "/delete_prop": responseBody = DeleteProp(requestBody); break;
                    case "/list_props": responseBody = ListProps(requestBody); break;
                    case "/validate": responseBody = ValidateProps(requestBody); break;
                    case "/get_nearby_entities": responseBody = ListProps(requestBody); break;
                    case "/get_camera_view": responseBody = GetCameraView(); break;
                    case "/save_project": responseBody = SaveProject(requestBody); break;
                    case "/undo": responseBody = Undo(requestBody); break;
                    case "/redo": responseBody = Redo(); break;
                    case "/camera/mode": responseBody = SetCameraMode(requestBody); break;
                    case "/camera/preset": responseBody = CameraPreset(requestBody); break;
                    case "/camera/rotate": responseBody = RotateCamera(requestBody); break;
                    case "/camera/zoom": responseBody = ZoomMap(requestBody); break;
                    case "/camera/focus": responseBody = FocusCamera(requestBody); break;
                    case "/set_visibility": responseBody = SetVisibility(requestBody); break;
                    case "/open_map": responseBody = OpenMap(requestBody); break;
                    case "/new_map": responseBody = NewMap(requestBody); break;
                    default:
                        statusCode = 404;
                        responseBody = new JObject { ["error"] = "unknown endpoint" };
                        break;
                }
            }
            catch (Exception ex)
            {
                statusCode = 500;
                responseBody = new JObject { ["error"] = ex.Message };
            }

            WriteJson(ctx.Response, statusCode, responseBody);
        }

        static void WriteJson(HttpListenerResponse response, int statusCode, JObject body)
        {
            var bytes = Encoding.UTF8.GetBytes(body.ToString(Formatting.None));
            try
            {
                response.StatusCode = statusCode;
                response.ContentType = "application/json";
                response.Headers.Add("Access-Control-Allow-Origin", "*");
                response.ContentLength64 = bytes.Length;
                using (var os = response.OutputStream)
                {
                    os.Write(bytes, 0, bytes.Length);
                }
            }
            catch
            {
                // client disconnected etc. - nothing to do
            }
        }

        // Marshals onto the WinForms UI thread: GameFileCache, ProjectForm and the render state
        // are not safe to touch from the HttpListener's background thread.
        T OnUiThread<T>(Func<T> action)
        {
            if (worldForm.InvokeRequired)
            {
                return (T)worldForm.Invoke(action);
            }
            return action();
        }

        static JObject Fail(string error)
        {
            return new JObject { ["success"] = false, ["error"] = error };
        }

        static JArray Vec(Vector3 v)
        {
            return new JArray(v.X, v.Y, v.Z);
        }

        // ---------- camera frame, rotation, ground ----------

        struct CameraFrame
        {
            public Vector3 Position;
            public Vector3 Forward; // horizontal, normalized
            public Vector3 Right;   // horizontal, normalized
            public float Yaw;       // radians, counter-clockwise from +Y (north)
        }

        CameraFrame GetCameraFrame()
        {
            var frame = new CameraFrame { Position = worldForm.GetCameraPosition() };
            Vector3 viewDir = worldForm.GetCameraViewDir();
            Vector3 fwd = new Vector3(viewDir.X, viewDir.Y, 0);
            if (fwd.LengthSquared() < 0.0001f) fwd = Vector3.UnitY;
            fwd.Normalize();
            frame.Forward = fwd;
            // GTA world is Z-up with +X east / +Y north, so forward x up points to the right.
            frame.Right = Vector3.Normalize(Vector3.Cross(fwd, Vector3.UnitZ));
            frame.Yaw = (float)Math.Atan2(-fwd.X, fwd.Y);
            return frame;
        }

        static float WorldYaw(YmapEntityDef ent)
        {
            Vector3 front = Vector3.Transform(Vector3.UnitY, ent.Orientation);
            return (float)Math.Atan2(-front.X, front.Y);
        }

        // GTA props' front side is their local -Y (verified in-game with prop_bench_01a), hence the
        // half turn between "facing the camera's forward" and the raw yaw.
        static float YawFromRelativeHeading(CameraFrame cam, float headingDeg)
        {
            return cam.Yaw + MathUtil.Pi + MathUtil.DegreesToRadians(headingDeg);
        }

        static float RelativeHeadingDeg(CameraFrame cam, float worldYaw)
        {
            float deg = MathUtil.RadiansToDegrees(worldYaw - cam.Yaw - MathUtil.Pi);
            deg = ((deg % 360f) + 540f) % 360f - 180f; // normalize to [-180, 180)
            return (float)Math.Round(deg, 1);
        }

        // CEntityDef stores the inverse rotation (see YmapEntityDef.SetOrientationRaw).
        static Quaternion RawRotationFromYaw(float yaw)
        {
            return Quaternion.Invert(Quaternion.RotationAxis(Vector3.UnitZ, yaw));
        }

        // Must NOT be called on the UI thread: collision (.ybn) streams in lazily, so the first ray
        // into an area often reports TestComplete=false and misses. Retry while the loader catches up.
        bool TrySnapToGround(float x, float y, float fromZ, YmapEntityDef ignore, out float groundZ)
        {
            groundZ = 0;
            // TestComplete isn't trustworthy right after the camera moves: until the space has indexed
            // the area there are no bounds to test, so a miss reports "complete". Require a few
            // consecutive complete misses before concluding there is no ground.
            int completeMisses = 0;
            for (int attempt = 0; attempt < 30; attempt++)
            {
                var ray = new Ray(new Vector3(x, y, fromZ), new Vector3(0, 0, -1));
                for (int skip = 0; skip < 5; skip++)
                {
                    var hit = OnUiThread(() => worldForm.Raycast(ray));
                    if (hit.Hit && ignore != null && hit.HitEntity == ignore)
                    {
                        ray.Position = hit.Position - new Vector3(0, 0, 0.01f); // look through the moved prop
                        continue;
                    }
                    if (hit.Hit)
                    {
                        groundZ = hit.Position.Z;
                        return true;
                    }
                    if (hit.TestComplete && ++completeMisses >= 8) return false;
                    break;
                }
                Thread.Sleep(100);
            }
            return false;
        }

        // Looks for the surface under (x, y), starting just above `referenceZ` so that bridges, awnings or
        // tree canopies overhead aren't mistaken for the ground; if that finds nothing (e.g. the spot is
        // uphill, above the start), searches again from high up. Worker thread only.
        bool TrySnapToSurfaceBelow(float x, float y, float referenceZ, YmapEntityDef ignore, out float groundZ)
        {
            return TrySnapToGround(x, y, referenceZ + 5f, ignore, out groundZ)
                || TrySnapToGround(x, y, referenceZ + 100f, ignore, out groundZ);
        }

        // Finds the height a prop's base should rest at, sampling the ground under the centre and the four
        // corners of its footprint: a single ray can slip through a gap in the collision mesh (a pier,
        // a grate) or land on a spot unrepresentative of the whole base. Nearly level ground: rest on the
        // highest sample so nothing sinks. Sloped ground: rest on the average. Worker thread only.
        bool TryFindSupport(Vector3 center, float yaw, Archetype arch, Vector3 scale, float referenceZ, YmapEntityDef ignore, out float supportZ)
        {
            supportZ = 0;
            var rotation = Quaternion.RotationAxis(Vector3.UnitZ, yaw);
            var points = new List<Vector3> { center };
            if (arch != null)
            {
                // Slightly inside the footprint, so a corner resting on an edge doesn't read the ground below it.
                Vector3 min = arch.BBMin * scale * 0.9f, max = arch.BBMax * scale * 0.9f;
                foreach (var corner in new[] { new Vector3(min.X, min.Y, 0), new Vector3(max.X, min.Y, 0), new Vector3(max.X, max.Y, 0), new Vector3(min.X, max.Y, 0) })
                {
                    points.Add(center + Vector3.Transform(corner, rotation));
                }
            }

            var heights = new List<float>();
            foreach (var point in points)
            {
                if (TrySnapToSurfaceBelow(point.X, point.Y, referenceZ, ignore, out float z)) heights.Add(z);
            }
            if (heights.Count == 0) return false;

            float spread = heights.Max() - heights.Min();
            supportZ = spread <= 0.15f ? heights.Max() : heights.Average();
            return true;
        }

        // ---------- geometric validation ----------

        const float OverlapTolerance = 0.03f;   // touching props are fine
        const float FloatTolerance = 0.05f;
        const float BuryTolerance = 0.15f;      // a little sinking into uneven ground looks natural
        const float OverhangTolerance = 0.25f;
        const float SteepGroundDegrees = 10f;

        static float Round2(float v)
        {
            return (float)Math.Round(v, 2);
        }

        // A world-space offset expressed as a move_prop delta in the camera's frame.
        static JObject CameraDelta(CameraFrame cam, Vector3 world)
        {
            var move = new JObject
            {
                ["forward"] = Round2(Vector3.Dot(world, cam.Forward)),
                ["right"] = Round2(Vector3.Dot(world, cam.Right)),
            };
            if (Math.Abs(world.Z) > 0.05f) move["up"] = Round2(world.Z);
            return move;
        }

        static string CameraSide(CameraFrame cam, Vector3 world)
        {
            float f = Vector3.Dot(world, cam.Forward), r = Vector3.Dot(world, cam.Right), u = world.Z;
            float af = Math.Abs(f), ar = Math.Abs(r), au = Math.Abs(u);
            if (au >= af && au >= ar) return u > 0 ? "top" : "bottom";
            if (af >= ar) return f > 0 ? "far side (away from camera)" : "near side (toward camera)";
            return r > 0 ? "right side" : "left side";
        }

        // Checks one placed prop against the other props, the world's collision geometry and the ground.
        // Must not be called on the UI thread.
        JObject ValidateProp(int id)
        {
            var issues = new JArray();
            var cam = default(CameraFrame);
            var box = default(EntityBox);
            bool hasBox = false, worldChecked = true;

            string error = OnUiThread(() =>
            {
                var ent = ResolveEntity(id);
                if (ent == null) return $"No prop with id {id}";
                cam = GetCameraFrame();
                hasBox = EntityBox.TryCreate(ent, out box);
                if (!hasBox) return null;

                // Other placed props (the world collision queries below don't see project ymaps).
                foreach (var other in ProjectEntities())
                {
                    if (other == ent || !EntityBox.TryCreate(other, out var otherBox)) continue;
                    float depth = box.Penetration(otherBox, out Vector3 pushAxis);
                    if (depth <= OverlapTolerance) continue;
                    issues.Add(new JObject
                    {
                        ["type"] = "overlap",
                        ["with"] = GetEntityId(other),
                        ["name"] = other._CEntityDef.archetypeName.ToString(),
                        ["depth"] = Round2(depth),
                        ["suggestedMove"] = CameraDelta(cam, pushAxis * (depth + 0.1f)),
                    });
                }

                return null;
            });
            if (error != null) return Fail(error);
            if (!hasBox)
            {
                return new JObject { ["ok"] = true, ["issues"] = issues, ["note"] = "Size unknown for this model; not checked" };
            }

            // Ground contact under each bottom corner first: how deep the base sits in the ground decides
            // where the world collision samples below may start (worker thread: waits for streaming).
            var gaps = new List<float>();
            var groundHeights = new List<float>();
            foreach (var corner in box.BottomCorners())
            {
                if (TrySnapToGround(corner.X, corner.Y, corner.Z + 3f, null, out float groundZ))
                {
                    gaps.Add(corner.Z - groundZ);
                    groundHeights.Add(groundZ);
                }
            }
            float sunkDepth = 0;
            if (gaps.Count > 0)
            {
                float minGap = gaps.Min(), maxGap = gaps.Max();
                sunkDepth = Math.Max(0, -minGap);
                if (minGap > FloatTolerance)
                {
                    issues.Add(new JObject { ["type"] = "floating", ["gap"] = Round2(minGap), ["suggestedMove"] = new JObject { ["up"] = Round2(-minGap) } });
                }
                else if (maxGap > OverhangTolerance)
                {
                    issues.Add(new JObject { ["type"] = "overhang", ["gap"] = Round2(maxGap) });
                }
                if (minGap < -BuryTolerance)
                {
                    issues.Add(new JObject { ["type"] = "buried", ["depth"] = Round2(-minGap), ["suggestedMove"] = new JObject { ["up"] = Round2(-minGap) } });
                }
                if (groundHeights.Count >= 2)
                {
                    float span = Math.Max(Math.Max(box.Half.X, box.Half.Y) * 2f, 0.5f);
                    float degrees = MathUtil.RadiansToDegrees((float)Math.Atan((groundHeights.Max() - groundHeights.Min()) / span));
                    if (degrees > SteepGroundDegrees)
                    {
                        issues.Add(new JObject { ["type"] = "steep_ground", ["degrees"] = (float)Math.Round(degrees, 1) });
                    }
                }
            }
            else
            {
                issues.Add(new JObject { ["type"] = "no_ground", ["note"] = "No surface found under the prop" });
            }

            // World geometry: fill the part of the box above the ground with spheres and see which touch
            // collision. Starting above the sunk depth keeps the ground itself out of this check (that is
            // the "buried" issue). Collision streams in lazily, so retry while the area isn't loaded.
            float floorClearance = 0.12f + sunkDepth;
            if (floorClearance + 0.2f < box.Half.Z * 2f)
            {
                var spheres = box.InteriorSpheres(floorClearance, 48, out float radius);
                int hits = 0;
                Vector3 hitOffset = Vector3.Zero;
                for (int attempt = 0; attempt < 30; attempt++)
                {
                    hits = 0;
                    hitOffset = Vector3.Zero;
                    bool complete = OnUiThread(() =>
                    {
                        bool allLoaded = true;
                        foreach (var sphere in spheres)
                        {
                            var hit = worldForm.Space.SphereIntersect(sphere);
                            if (!hit.TestComplete) allLoaded = false;
                            if (!hit.Hit) continue;
                            hits++;
                            hitOffset += sphere.Center - box.Center;
                        }
                        return allLoaded;
                    });
                    worldChecked = complete;
                    if (complete) break;
                    Thread.Sleep(100);
                }
                if (hits > 0)
                {
                    float fraction = (float)hits / spheres.Count;
                    Vector3 direction = hitOffset / hits;
                    // Hits all around cancel out; the average then says nothing about a side.
                    bool throughout = fraction >= 0.6f || direction.Length() < box.BoundingRadius * 0.2f;
                    var worldCollision = new JObject
                    {
                        ["type"] = "world_collision",
                        ["side"] = throughout ? "most of the prop (inside a structure or terrain)" : CameraSide(cam, direction),
                        ["fraction"] = Round2(fraction),
                    };
                    Vector3 away = new Vector3(-direction.X, -direction.Y, 0);
                    if (!throughout && away.LengthSquared() > 1e-4f)
                    {
                        worldCollision["suggestedMove"] = CameraDelta(cam, Vector3.Normalize(away) * (radius * 2f + 0.1f));
                    }
                    issues.Add(worldCollision);
                }
            }

            var result = new JObject { ["ok"] = issues.Count == 0 && worldChecked, ["issues"] = issues };
            if (!worldChecked) result["note"] = "World collision data for this area wasn't fully loaded; check again";
            return result;
        }

        // Body: { "ids": [..] } or {} for every prop. Returns only props with problems.
        JObject ValidateProps(JObject req)
        {
            var ids = req["ids"]?.ToObject<int[]>();
            var targets = (ids != null && ids.Length > 0)
                ? ids.ToList()
                : OnUiThread(() => ProjectEntities().Select(GetEntityId).ToList());

            var problems = new JArray();
            foreach (int id in targets)
            {
                var validation = ValidateProp(id);
                if (validation["ok"]?.ToObject<bool>() == true) continue;
                problems.Add(new JObject
                {
                    ["id"] = id,
                    ["name"] = OnUiThread(() => ResolveEntity(id)?._CEntityDef.archetypeName.ToString()),
                    ["validation"] = validation,
                });
            }
            return new JObject { ["success"] = true, ["checked"] = targets.Count, ["problems"] = problems };
        }

        // ---------- entity ids and info ----------

        int GetEntityId(YmapEntityDef ent)
        {
            if (!idsByEntity.TryGetValue(ent, out int id))
            {
                id = nextEntityId++;
                idsByEntity[ent] = id;
                entitiesById[id] = ent;
            }
            return id;
        }

        YmapEntityDef ResolveEntity(int id)
        {
            if (!entitiesById.TryGetValue(id, out var ent)) return null;
            if (ent.Ymap?.AllEntities == null || Array.IndexOf(ent.Ymap.AllEntities, ent) < 0)
            {
                entitiesById.Remove(id);
                idsByEntity.Remove(ent);
                return null;
            }
            return ent;
        }

        JObject EntityInfo(YmapEntityDef ent, CameraFrame cam)
        {
            return new JObject
            {
                ["id"] = GetEntityId(ent),
                ["name"] = ent._CEntityDef.archetypeName.ToString(),
                ["position"] = Vec(ent.Position),
                ["heading"] = RelativeHeadingDeg(cam, WorldYaw(ent)),
                ["distance"] = (float)Math.Round(Vector3.Distance(ent.Position, cam.Position), 2),
                ["hidden"] = hiddenIds.Contains(GetEntityId(ent)),
                // Position within its ymap, which is stable across save and load (used to persist folders).
                ["index"] = ent.Ymap?.AllEntities != null ? Array.IndexOf(ent.Ymap.AllEntities, ent) : -1,
            };
        }

        IEnumerable<YmapEntityDef> ProjectEntities()
        {
            var ymaps = worldForm.ProjectForm?.CurrentProjectFile?.YmapFiles;
            if (ymaps == null) yield break;
            foreach (var ymap in ymaps)
            {
                if (ymap?.AllEntities == null) continue;
                foreach (var ent in ymap.AllEntities) yield return ent;
            }
        }

        void Record(string group, object op)
        {
            future.Clear(); // a new edit invalidates anything that could be redone
            var last = history.Count > 0 ? history[history.Count - 1] : null;
            if (group != null && last != null && last.Group == group)
            {
                last.Ops.Add(op);
                return;
            }
            var step = new HistoryStep { Group = group };
            step.Ops.Add(op);
            history.Add(step);
            if (history.Count > MaxHistorySteps) history.RemoveAt(0);
        }

        static string Group(JObject req)
        {
            var group = req["group"]?.ToString();
            return string.IsNullOrEmpty(group) ? null : group;
        }

        bool HasUnsavedChanges()
        {
            var ymaps = worldForm.ProjectForm?.CurrentProjectFile?.YmapFiles;
            return ymaps != null && ymaps.Any(y => y != null && y.HasChanged);
        }

        // Clears ids and history, e.g. when a different map is loaded.
        void ForgetEntities()
        {
            entitiesById.Clear();
            idsByEntity.Clear();
            history.Clear();
            future.Clear();
            hiddenIds.Clear();
            PublishHidden();
        }

        // UI thread only.
        void PublishHidden()
        {
            var list = new List<YmapEntityDef>(hiddenIds.Count);
            foreach (int id in hiddenIds)
            {
                if (entitiesById.TryGetValue(id, out var ent)) list.Add(ent);
            }
            hiddenSnapshot = list.ToArray();
        }

        // Called by WorldForm on the render thread each frame, after the renderer clears its hide list.
        public void ApplyHiddenEntities(Rendering.Renderer renderer)
        {
            foreach (var ent in hiddenSnapshot)
            {
                renderer.RenderHideEntity(ent);
            }
        }

        // CodeWalker only deletes the *selected* entity. UI thread only.
        bool RemoveEntity(ProjectForm pf, YmapEntityDef ent)
        {
            pf.SetProjectItem(ent);
            pf.DeleteEntity();
            return ent.Ymap?.AllEntities == null || Array.IndexOf(ent.Ymap.AllEntities, ent) < 0;
        }

        // CloseProject asks "save before closing?" in a MessageBox for every changed file, which would
        // block this request on a dialog nobody sees. The host app confirms instead, so clear the
        // flags first. UI thread only.
        void DiscardAndCloseProject(ProjectForm pf)
        {
            if (!pf.IsProjectLoaded) return;
            foreach (var ymap in pf.CurrentProjectFile.YmapFiles)
            {
                if (ymap != null) ymap.HasChanged = false;
            }
            pf.CurrentProjectFile.HasChanged = false;
            pf.CloseProject();
            ForgetEntities();
        }

        // Ensures a project with a selected ymap exists, creating both if needed. UI thread only.
        ProjectForm EnsureProjectWithYmap(out string error)
        {
            error = null;
            var pf = worldForm.EnsureProjectForm();
            if (!pf.IsProjectLoaded)
            {
                pf.NewProject();
            }
            if (pf.CurrentYmapFile == null)
            {
                // CurrentYmapFile follows the project window's selection, so it is null whenever
                // something else was selected. Fall back to the project's last ymap, or make one.
                var ymaps = pf.CurrentProjectFile.YmapFiles;
                if (ymaps.Count == 0)
                {
                    pf.NewYmap(); // adds to the project but does not select it
                }
                if (ymaps.Count > 0)
                {
                    pf.CurrentYmapFile = ymaps[ymaps.Count - 1];
                }
            }
            if (pf.CurrentYmapFile == null)
            {
                error = "Could not find or create a ymap in the project";
            }
            return pf;
        }

        // ---------- endpoints ----------

        JObject GetStatus()
        {
            return OnUiThread(() => new JObject
            {
                ["worldLoaded"] = worldForm.IsWorldLoaded,
                ["embedded"] = worldForm.IsEmbedded,
                ["projectOpen"] = worldForm.ProjectForm?.IsProjectLoaded ?? false,
                ["propCount"] = ProjectEntities().Count(),
                ["unsaved"] = HasUnsavedChanges(),
                ["undoSteps"] = history.Count,
                ["redoSteps"] = future.Count,
                ["mapName"] = CurrentMapName(),
                ["cameraMode"] = worldForm.IsMapView ? "2d" : "3d",
            });
        }

        string CurrentMapName()
        {
            var pf = worldForm.ProjectForm;
            var ymaps = pf?.CurrentProjectFile?.YmapFiles;
            if (ymaps == null || ymaps.Count == 0) return null;
            var ymap = pf.CurrentYmapFile ?? ymaps[ymaps.Count - 1];
            return string.IsNullOrEmpty(ymap.FilePath) ? ymap.Name : Path.GetFileName(ymap.FilePath);
        }

        JObject SetEmbedBounds(JObject req)
        {
            int x = req["x"]?.ToObject<int>() ?? 0;
            int y = req["y"]?.ToObject<int>() ?? 0;
            int width = req["width"]?.ToObject<int>() ?? 0;
            int height = req["height"]?.ToObject<int>() ?? 0;
            return OnUiThread(() =>
            {
                if (!worldForm.IsEmbedded) return Fail("CodeWalker was not started with embed=<hwnd>");
                EmbedHost.SetBounds(worldForm.Handle, x, y, width, height);
                return new JObject { ["success"] = true };
            });
        }

        JObject ReleaseEmbedFocus()
        {
            return OnUiThread(() =>
            {
                if (!worldForm.IsEmbedded) return Fail("CodeWalker was not started with embed=<hwnd>");
                EmbedHost.ReleaseFocus(worldForm.Handle, WorldForm.EmbedParent);
                return new JObject { ["success"] = true };
            });
        }

        JObject SearchProps(JObject req)
        {
            string query = (req["query"]?.ToString() ?? "").ToLowerInvariant();
            int maxResults = req["maxResults"]?.ToObject<int?>() ?? 20;

            return OnUiThread(() =>
            {
                var matches = worldForm.GameFileCache.GetLoadedArchetypes()
                    .Where(a => !string.IsNullOrEmpty(a.Name) && a.Name.ToLowerInvariant().Contains(query))
                    .Take(maxResults)
                    .Select(a => (JToken)new JObject
                    {
                        ["name"] = a.Name,
                        ["bbMin"] = Vec(a.BBMin),
                        ["bbMax"] = Vec(a.BBMax),
                        ["bsRadius"] = a.BSRadius,
                    });
                return new JObject { ["results"] = new JArray(matches) };
            });
        }

        JObject PlaceEntity(JObject req)
        {
            string model = req["model"]?.ToString();
            float forward = req["forward"]?.ToObject<float?>() ?? 0f;
            float right = req["right"]?.ToObject<float?>() ?? 0f;
            float up = req["up"]?.ToObject<float?>() ?? 0f;
            float headingDeg = req["heading"]?.ToObject<float?>() ?? 0f;

            string group = Group(req);

            if (string.IsNullOrWhiteSpace(model)) return Fail("model is required");
            model = model.ToLowerInvariant();
            uint hash = JenkHash.GenHash(model);

            // Phase 1 (UI thread): validate and compute the target from the camera.
            string error = null;
            Archetype arch = null;
            var cam = default(CameraFrame);
            OnUiThread(() =>
            {
                if (!worldForm.IsWorldLoaded) { error = "The world is still loading"; return 0; }
                arch = worldForm.GameFileCache.GetArchetype(hash);
                if (arch == null) { error = $"Unknown prop model '{model}' - use /search_props first"; return 0; }
                cam = GetCameraFrame();
                return 0;
            });
            if (error != null) return Fail(error);

            Vector3 target = cam.Position + cam.Forward * forward + cam.Right * right;

            // Phase 2 (this worker thread): ground snap. The prop's origin is often not at its base
            // (prop_skid_tent_01's bottom is 0.61 m below it), so rest the bounding box bottom on the ground.
            float placeYaw = YawFromRelativeHeading(cam, headingDeg);
            bool grounded = TryFindSupport(target, placeYaw, arch, Vector3.One, cam.Position.Z, null, out float groundZ);
            Vector3 pos = new Vector3(target.X, target.Y, grounded ? groundZ - arch.BBMin.Z + up : cam.Position.Z + up);

            // Phase 3 (UI thread): create the entity.
            var placed = OnUiThread(() =>
            {
                var pf = EnsureProjectWithYmap(out string projectError);
                if (projectError != null) return Fail(projectError);

                var ent = pf.NewEntity();
                if (ent == null) return Fail("NewEntity() returned null");

                lock (pf.ProjectSyncRoot)
                {
                    // Mirrors EditYmapEntityPanel: the serialized def must carry the archetype
                    // name too, otherwise NewEntity's placeholder model is what renders and saves.
                    ent._CEntityDef.archetypeName = new MetaHash(hash);
                    JenkIndex.Ensure(model);
                    ent.SetArchetype(arch);
                    ent.SetPositionRaw(pos);
                    ent.SetOrientationRaw(RawRotationFromYaw(placeYaw));
                }
                pf.SetYmapHasChanged(true);
                pf.AddEntityToProject();
                pf.ShowEditYmapEntityPanel(false); // refresh the panel, it still shows the placeholder
                pf.ProjectExplorer?.UpdateEntityTreeNode(ent); // tree was drawn before the model change

                var info = EntityInfo(ent, cam);
                Record(group, new PlacedOp { Id = GetEntityId(ent) });
                info["success"] = true;
                info["grounded"] = grounded;
                return info;
            });
            if (placed["success"]?.ToObject<bool>() == true)
            {
                placed["validation"] = ValidateProp(placed["id"].ToObject<int>());
            }
            return placed;
        }

        // Moves a prop by a delta in the camera's frame and/or turns it. Without "up" the prop is
        // re-snapped to the ground at its new spot; with "up" its height changes by that amount.
        JObject MoveProp(JObject req)
        {
            int id = req["id"]?.ToObject<int?>() ?? 0;
            float forward = req["forward"]?.ToObject<float?>() ?? 0f;
            float right = req["right"]?.ToObject<float?>() ?? 0f;
            float? up = req["up"]?.ToObject<float?>();
            float turnDeg = req["turn"]?.ToObject<float?>() ?? 0f;
            string group = Group(req);

            YmapEntityDef ent = null;
            var cam = default(CameraFrame);
            string error = OnUiThread(() =>
            {
                ent = ResolveEntity(id);
                if (ent == null) return $"No prop with id {id}";
                cam = GetCameraFrame();
                return null;
            });
            if (error != null) return Fail(error);

            Vector3 pos = OnUiThread(() => ent.Position) + cam.Forward * forward + cam.Right * right;
            bool grounded = true;
            if (up.HasValue)
            {
                pos.Z += up.Value;
            }
            else if (forward != 0 || right != 0 || turnDeg != 0)
            {
                Archetype moveArch = null;
                Vector3 moveScale = Vector3.One;
                float newYaw = OnUiThread(() =>
                {
                    moveArch = ent.Archetype;
                    moveScale = ent.Scale;
                    return WorldYaw(ent) + MathUtil.DegreesToRadians(turnDeg);
                });
                grounded = TryFindSupport(pos, newYaw, moveArch, moveScale, Math.Max(cam.Position.Z, pos.Z), ent, out float groundZ);
                if (grounded) pos.Z = groundZ - (moveArch?.BBMin.Z ?? 0f) * moveScale.Z;
            }

            var moved = OnUiThread(() =>
            {
                if (ResolveEntity(id) == null) return Fail($"Prop {id} was removed");
                var pf = worldForm.ProjectForm;
                float yaw = WorldYaw(ent) + MathUtil.DegreesToRadians(turnDeg);
                var before = ent._CEntityDef;
                Record(group, new MovedOp
                {
                    Id = id,
                    RawPosition = before.position,
                    RawRotation = new Quaternion(before.rotation.X, before.rotation.Y, before.rotation.Z, before.rotation.W),
                });
                lock (pf.ProjectSyncRoot)
                {
                    ent.SetPositionRaw(pos);
                    ent.SetOrientationRaw(RawRotationFromYaw(yaw));
                }
                pf.CurrentYmapFile = ent.Ymap;
                pf.SetYmapHasChanged(true);

                var info = EntityInfo(ent, cam);
                info["success"] = true;
                info["grounded"] = grounded;
                return info;
            });
            if (moved["success"]?.ToObject<bool>() == true)
            {
                moved["validation"] = ValidateProp(id);
            }
            return moved;
        }

        JObject DeleteProp(JObject req)
        {
            int id = req["id"]?.ToObject<int?>() ?? 0;
            string group = Group(req);
            return OnUiThread(() =>
            {
                var ent = ResolveEntity(id);
                if (ent == null) return Fail($"No prop with id {id}");
                var pf = worldForm.ProjectForm;
                if (pf == null) return Fail("No project open");

                var ymap = ent.Ymap;
                if (!RemoveEntity(pf, ent)) return Fail($"CodeWalker refused to delete prop {id}");
                // The id stays reserved: undo brings the prop back under the same id.
                entitiesById.Remove(id);
                idsByEntity.Remove(ent);
                Record(group, new DeletedOp { Id = id, Removed = ent, Ymap = ymap });
                PublishHidden();
                return new JObject { ["success"] = true, ["id"] = id };
            });
        }

        // Props in the current project. Body: { "radius": meters } to limit to around the camera.
        JObject ListProps(JObject req)
        {
            float? radius = req["radius"]?.ToObject<float?>();
            return OnUiThread(() =>
            {
                var cam = GetCameraFrame();
                var results = new JArray();
                foreach (var ent in ProjectEntities())
                {
                    if (radius.HasValue && Vector3.Distance(ent.Position, cam.Position) > radius.Value) continue;
                    results.Add(EntityInfo(ent, cam));
                }
                return new JObject { ["results"] = results };
            });
        }

        // Applies the inverse of a step and returns the inverse, so undo and redo share one code path:
        // undo reverts a history step and pushes its inverse to the redo stack, and vice versa.
        // UI thread only.
        HistoryStep Revert(ProjectForm pf, HistoryStep step, out int reverted)
        {
            var inverse = new HistoryStep { Group = step.Group };
            reverted = 0;
            for (int i = step.Ops.Count - 1; i >= 0; i--)
            {
                switch (step.Ops[i])
                {
                    case PlacedOp placed:
                    {
                        var ent = ResolveEntity(placed.Id);
                        if (ent == null) break;
                        var ymap = ent.Ymap;
                        if (!RemoveEntity(pf, ent)) break;
                        entitiesById.Remove(placed.Id);
                        idsByEntity.Remove(ent);
                        inverse.Ops.Add(new DeletedOp { Id = placed.Id, Removed = ent, Ymap = ymap });
                        reverted++;
                        break;
                    }
                    case MovedOp moved:
                    {
                        var ent = ResolveEntity(moved.Id);
                        if (ent == null) break;
                        var current = ent._CEntityDef;
                        inverse.Ops.Add(new MovedOp
                        {
                            Id = moved.Id,
                            RawPosition = current.position,
                            RawRotation = new Quaternion(current.rotation.X, current.rotation.Y, current.rotation.Z, current.rotation.W),
                        });
                        lock (pf.ProjectSyncRoot)
                        {
                            ent.SetPositionRaw(moved.RawPosition);
                            ent.SetOrientationRaw(moved.RawRotation);
                        }
                        pf.CurrentYmapFile = ent.Ymap;
                        pf.SetYmapHasChanged(true);
                        reverted++;
                        break;
                    }
                    case DeletedOp deleted:
                    {
                        if (!pf.CurrentProjectFile.YmapFiles.Contains(deleted.Ymap)) break;
                        pf.CurrentYmapFile = deleted.Ymap;
                        // Copying the removed entity keeps every CEntityDef field (flags, LOD, ...).
                        var restored = pf.NewEntity(deleted.Removed, true);
                        if (restored == null) break;
                        entitiesById[deleted.Id] = restored;
                        idsByEntity[restored] = deleted.Id;
                        pf.SetYmapHasChanged(true);
                        pf.ProjectExplorer?.UpdateEntityTreeNode(restored);
                        inverse.Ops.Add(new PlacedOp { Id = deleted.Id });
                        reverted++;
                        break;
                    }
                }
            }
            PublishHidden();
            return inverse;
        }

        // Reverts the most recent history step. Body: { "exceptGroup": "..." } skips steps of that
        // group, so an agent turn can undo the previous turn rather than its own edits.
        JObject Undo(JObject req)
        {
            string exceptGroup = req["exceptGroup"]?.ToString();
            return OnUiThread(() =>
            {
                var pf = worldForm.ProjectForm;
                if (pf == null || !pf.IsProjectLoaded) return Fail("Nothing to undo");
                int index = history.Count - 1;
                while (index >= 0 && exceptGroup != null && history[index].Group == exceptGroup) index--;
                if (index < 0) return Fail("Nothing to undo");
                var step = history[index];
                history.RemoveAt(index);

                future.Add(Revert(pf, step, out int reverted));
                return new JObject { ["success"] = true, ["reverted"] = reverted, ["undoSteps"] = history.Count, ["redoSteps"] = future.Count };
            });
        }

        JObject Redo()
        {
            return OnUiThread(() =>
            {
                var pf = worldForm.ProjectForm;
                if (pf == null || !pf.IsProjectLoaded || future.Count == 0) return Fail("Nothing to redo");
                var step = future[future.Count - 1];
                future.RemoveAt(future.Count - 1);

                history.Add(Revert(pf, step, out int reverted));
                return new JObject { ["success"] = true, ["reverted"] = reverted, ["undoSteps"] = history.Count, ["redoSteps"] = future.Count };
            });
        }

        // Editor-only: hidden props are skipped when rendering but stay in the map and in saved files.
        // Body: { "ids": [1, 2], "visible": false }
        JObject SetVisibility(JObject req)
        {
            var ids = req["ids"]?.ToObject<int[]>() ?? new int[0];
            bool visible = req["visible"]?.ToObject<bool?>() ?? true;
            return OnUiThread(() =>
            {
                int changed = 0;
                foreach (int id in ids)
                {
                    if (ResolveEntity(id) == null) continue;
                    if (visible ? hiddenIds.Remove(id) : hiddenIds.Add(id)) changed++;
                }
                PublishHidden();
                return new JObject { ["success"] = true, ["changed"] = changed };
            });
        }

        // ---------- camera ----------

        // Where the camera is looking at the ground: along the view ray in 3D, straight below in 2D.
        // Must not be called on the UI thread (ground snapping waits for collision to stream in).
        Vector3 CameraLookPoint(CameraFrame cam, Vector3 viewDir, bool mapView, Vector3 focus)
        {
            if (!mapView && viewDir.Z < -0.05f)
            {
                var hit = OnUiThread(() => worldForm.Raycast(new Ray(cam.Position, viewDir)));
                if (hit.Hit && hit.HitDist < 300f) return hit.Position;
            }
            Vector3 xy = mapView ? focus : cam.Position + cam.Forward * 20f;
            float fromZ = Math.Max(cam.Position.Z, focus.Z) + 100f;
            return new Vector3(xy.X, xy.Y, TrySnapToGround(xy.X, xy.Y, fromZ, null, out float z) ? z : cam.Position.Z - 20f);
        }

        JObject CameraState()
        {
            return OnUiThread(() =>
            {
                var cam = GetCameraFrame();
                return new JObject
                {
                    ["success"] = true,
                    ["mode"] = worldForm.IsMapView ? "2d" : "3d",
                    ["position"] = Vec(worldForm.IsMapView ? worldForm.CameraFocusPosition : cam.Position),
                    // Degrees counter-clockwise from north (+Y).
                    ["heading"] = (float)Math.Round(((MathUtil.RadiansToDegrees(cam.Yaw) % 360f) + 360f) % 360f, 1),
                };
            });
        }

        // Body: { "mode": "3d" | "2d" }
        JObject SetCameraMode(JObject req)
        {
            string mode = req["mode"]?.ToString();
            if (mode != "3d" && mode != "2d") return Fail("mode must be \"3d\" or \"2d\"");
            OnUiThread(() =>
            {
                bool toMap = mode == "2d";
                if (toMap && !worldForm.IsMapView)
                {
                    // Centre the map where the camera was, not on the orbit pivot.
                    var cam = GetCameraFrame();
                    worldForm.SetMapCenter(cam.Position);
                    if (worldForm.MapViewSize < 40f) worldForm.MapViewSize = 80f;
                }
                worldForm.SetMapView(toMap);
                return 0;
            });
            return CameraState();
        }

        // Body: { "name": "eye_level" | "bird" | "north" }
        JObject CameraPreset(JObject req)
        {
            string name = req["name"]?.ToString();
            bool wasMap = false;
            var cam = default(CameraFrame);
            Vector3 viewDir = Vector3.Zero, focus = Vector3.Zero;
            OnUiThread(() =>
            {
                wasMap = worldForm.IsMapView;
                cam = GetCameraFrame();
                viewDir = worldForm.GetCameraViewDir();
                focus = worldForm.CameraFocusPosition;
                return 0;
            });

            Vector3 position, direction;
            switch (name)
            {
                case "eye_level":
                {
                    Vector3 spot = wasMap ? focus : cam.Position;
                    float groundZ = TrySnapToGround(spot.X, spot.Y, spot.Z + 100f, null, out float z) ? z : spot.Z;
                    position = new Vector3(spot.X, spot.Y, groundZ + 1.7f);
                    direction = cam.Forward - new Vector3(0, 0, 0.05f);
                    break;
                }
                case "bird":
                {
                    Vector3 look = CameraLookPoint(cam, viewDir, wasMap, focus);
                    position = look - cam.Forward * 25f + new Vector3(0, 0, 25f);
                    direction = look - position;
                    break;
                }
                case "north":
                {
                    if (wasMap) return CameraState(); // the 2D map is always north-up
                    float horizontal = (float)Math.Sqrt(viewDir.X * viewDir.X + viewDir.Y * viewDir.Y);
                    position = cam.Position;
                    direction = new Vector3(0, Math.Max(horizontal, 0.05f), viewDir.Z);
                    break;
                }
                default:
                    return Fail("name must be eye_level, bird or north");
            }

            OnUiThread(() =>
            {
                if (worldForm.IsMapView) worldForm.SetMapView(false);
                worldForm.SetCameraPose(position, direction);
                return 0;
            });
            return CameraState();
        }

        // Orbits the camera around the point it looks at. Body: { "degrees": 90 } (positive = counter-clockwise from above)
        JObject RotateCamera(JObject req)
        {
            float degrees = req["degrees"]?.ToObject<float?>() ?? 90f;
            bool mapView = false;
            var cam = default(CameraFrame);
            Vector3 viewDir = Vector3.Zero, focus = Vector3.Zero;
            OnUiThread(() =>
            {
                mapView = worldForm.IsMapView;
                cam = GetCameraFrame();
                viewDir = worldForm.GetCameraViewDir();
                focus = worldForm.CameraFocusPosition;
                return 0;
            });
            if (mapView) return Fail("The 2D map is always north-up; switch to 3D to rotate");

            Vector3 look = CameraLookPoint(cam, viewDir, false, focus);
            var turn = Quaternion.RotationAxis(Vector3.UnitZ, MathUtil.DegreesToRadians(degrees));
            Vector3 position = look + Vector3.Transform(cam.Position - look, turn);
            Vector3 direction = Vector3.Transform(viewDir, turn);
            OnUiThread(() =>
            {
                worldForm.SetCameraPose(position, direction);
                return 0;
            });
            return CameraState();
        }

        // 2D map zoom. Body: { "factor": 0.5 } (below 1 zooms in)
        JObject ZoomMap(JObject req)
        {
            float factor = req["factor"]?.ToObject<float?>() ?? 1f;
            if (factor <= 0) return Fail("factor must be positive");
            OnUiThread(() =>
            {
                if (worldForm.IsMapView) worldForm.MapViewSize = worldForm.MapViewSize * factor;
                return 0;
            });
            return CameraState();
        }

        // Props closer than this belong to the same scene when focusing.
        const float FocusClusterDistance = 40f;
        int focusCycle;
        string focusSignature;

        // Groups props into scenes: single-linkage clustering, so a prop joins a group if it is within
        // FocusClusterDistance of any member.
        static List<List<YmapEntityDef>> ClusterProps(List<YmapEntityDef> props)
        {
            var parent = Enumerable.Range(0, props.Count).ToArray();
            int Find(int i) { while (parent[i] != i) i = parent[i] = parent[parent[i]]; return i; }
            float limit = FocusClusterDistance * FocusClusterDistance;
            for (int i = 0; i < props.Count; i++)
            {
                for (int j = i + 1; j < props.Count; j++)
                {
                    if (Vector3.DistanceSquared(props[i].Position, props[j].Position) <= limit)
                    {
                        parent[Find(i)] = Find(j);
                    }
                }
            }
            return props.Select((p, i) => (p, root: Find(i)))
                .GroupBy(x => x.root)
                .Select(g => g.Select(x => x.p).ToList())
                .ToList();
        }

        // Frames props in view. Body: { "ids": [..] } frames exactly those props; {} frames the biggest
        // scene in the map, and each further call moves to the next scene.
        JObject FocusCamera(JObject req)
        {
            var ids = req["ids"]?.ToObject<int[]>();
            return OnUiThread(() =>
            {
                var cam = GetCameraFrame();
                List<YmapEntityDef> props;
                int clusterIndex = 0, clusterCount = 1;

                if (ids != null && ids.Length > 0)
                {
                    props = ids.Select(ResolveEntity).Where(e => e != null).ToList();
                }
                else
                {
                    var clusters = ClusterProps(ProjectEntities().ToList())
                        .OrderByDescending(c => c.Count)
                        .ThenBy(c => c.Min(e => Vector3.Distance(e.Position, cam.Position)))
                        .ToList();
                    if (clusters.Count == 0) return Fail("No props to focus on");

                    // Restart the cycle whenever the map's props change.
                    string signature = string.Join(",", clusters.Select(c => c.Count)) + ":" + ProjectEntities().Count();
                    if (signature != focusSignature)
                    {
                        focusSignature = signature;
                        focusCycle = 0;
                    }
                    clusterCount = clusters.Count;
                    clusterIndex = focusCycle % clusterCount;
                    focusCycle++;
                    props = clusters[clusterIndex];
                }
                if (props.Count == 0) return Fail("No props to focus on");

                Vector3 min = props[0].Position, max = props[0].Position;
                foreach (var ent in props)
                {
                    min = Vector3.Min(min, ent.Position);
                    max = Vector3.Max(max, ent.Position);
                }
                Vector3 center = (min + max) * 0.5f;
                // Bounding sphere of the props themselves, not just their origins.
                float radius = 3f;
                foreach (var ent in props)
                {
                    radius = Math.Max(radius, Vector3.Distance(ent.Position, center) + ent.BSRadius);
                }

                if (worldForm.IsMapView)
                {
                    worldForm.SetMapCenter(center);
                    worldForm.MapViewSize = Math.Max(radius * 2.3f, 15f); // view height; width is wider
                }
                else
                {
                    // Distance at which the sphere fits the vertical field of view, seen from 35 degrees up.
                    float halfFov = Math.Max(worldForm.CameraFieldOfView, 0.3f) * 0.5f;
                    float distance = radius / (float)Math.Sin(halfFov) * 1.05f;
                    float pitch = MathUtil.DegreesToRadians(35f);
                    Vector3 direction = cam.Forward * (float)Math.Cos(pitch) - Vector3.UnitZ * (float)Math.Sin(pitch);
                    worldForm.SetCameraPose(center - direction * distance, direction);
                }

                return new JObject
                {
                    ["success"] = true,
                    ["focused"] = props.Count,
                    ["cluster"] = clusterIndex + 1,
                    ["clusters"] = clusterCount,
                };
            });
        }

        static JObject UnsavedFailure()
        {
            var result = Fail("The current map has unsaved changes");
            result["unsaved"] = true;
            return result;
        }

        // Replaces the current map with a .ymap from disk and flies the camera to it.
        // Body: { "path": absolute .ymap path, "discardChanges": bool }
        JObject OpenMap(JObject req)
        {
            string path = req["path"]?.ToString();
            bool discard = req["discardChanges"]?.ToObject<bool?>() ?? false;
            return OnUiThread(() =>
            {
                if (!worldForm.IsWorldLoaded) return Fail("The world is still loading");
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return Fail($"File not found: {path}");
                if (HasUnsavedChanges() && !discard) return UnsavedFailure();

                var pf = worldForm.EnsureProjectForm();
                DiscardAndCloseProject(pf);
                ForgetEntities();

                pf.NewProject();
                var ymap = pf.CurrentProjectFile.AddYmapFile(path);
                if (ymap == null) return Fail("Could not add the ymap to the project");
                try
                {
                    ymap.Load(File.ReadAllBytes(path));
                    ymap.InitYmapEntityArchetypes(worldForm.GameFileCache);
                }
                catch (Exception ex)
                {
                    DiscardAndCloseProject(pf);
                    return Fail($"Could not read {Path.GetFileName(path)}: {ex.Message}");
                }
                ymap.HasChanged = false;
                pf.CurrentProjectFile.HasChanged = false;
                pf.CurrentYmapFile = ymap;

                var entities = ymap.AllEntities ?? new YmapEntityDef[0];
                if (entities.Length > 0)
                {
                    Vector3 min = entities[0].Position, max = entities[0].Position;
                    foreach (var ent in entities)
                    {
                        min = Vector3.Min(min, ent.Position);
                        max = Vector3.Max(max, ent.Position);
                    }
                    Vector3 center = (min + max) * 0.5f;
                    Vector3 halfExtent = Vector3.Max((max - min) * 0.5f, new Vector3(10f));
                    worldForm.GoToPosition(center, halfExtent);
                }

                return new JObject
                {
                    ["success"] = true,
                    ["mapName"] = Path.GetFileName(path),
                    ["propCount"] = entities.Length,
                };
            });
        }

        // Starts an empty map; the next placement creates it. Body: { "discardChanges": bool }
        JObject NewMap(JObject req)
        {
            bool discard = req["discardChanges"]?.ToObject<bool?>() ?? false;
            return OnUiThread(() =>
            {
                var pf = worldForm.ProjectForm;
                if (pf == null || !pf.IsProjectLoaded) return new JObject { ["success"] = true };
                if (HasUnsavedChanges() && !discard) return UnsavedFailure();
                DiscardAndCloseProject(pf);
                return new JObject { ["success"] = true };
            });
        }

        JObject GetCameraView()
        {
            return OnUiThread(() =>
            {
                Vector3 pos = worldForm.GetCameraPosition();
                Vector3 dir = worldForm.GetCameraViewDir();
                return new JObject
                {
                    ["position"] = Vec(pos),
                    ["forward"] = Vec(dir),
                };
            });
        }

        // Writes the current project ymap to disk without CodeWalker's Save dialog, which would
        // block this request until a human answered it. Body: { "path": "C:\\...\\name.ymap" }
        // (optional once the ymap has been saved before).
        JObject SaveProject(JObject req)
        {
            string requestedPath = req["path"]?.ToString();

            return OnUiThread(() =>
            {
                var pf = worldForm.ProjectForm;
                if (pf == null || !pf.IsProjectLoaded) return Fail("No project open");
                var ymaps = pf.CurrentProjectFile.YmapFiles;
                var ymap = pf.CurrentYmapFile ?? (ymaps.Count > 0 ? ymaps[ymaps.Count - 1] : null);
                if (ymap == null) return Fail("Project has no ymap to save");

                string filepath = !string.IsNullOrWhiteSpace(requestedPath) ? requestedPath : ymap.FilePath;
                if (string.IsNullOrWhiteSpace(filepath) || !Path.IsPathRooted(filepath))
                {
                    return Fail("This ymap has never been saved - pass an absolute \"path\" ending in .ymap");
                }
                if (!filepath.EndsWith(".ymap", StringComparison.OrdinalIgnoreCase))
                {
                    filepath += ".ymap";
                }

                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(filepath));
                    string oldRelative = pf.CurrentProjectFile.GetRelativePath(string.IsNullOrEmpty(ymap.FilePath) ? ymap.Name : ymap.FilePath);

                    pf.CurrentYmapFile = ymap;
                    pf.AutoUpdateYmapFlagsExtents();
                    byte[] data;
                    lock (pf.ProjectSyncRoot)
                    {
                        ymap.SetFilePath(filepath);
                        data = ymap.Save();
                    }
                    File.WriteAllBytes(filepath, data);

                    pf.SetYmapHasChanged(false);
                    pf.CurrentProjectFile.RenameYmap(oldRelative, pf.CurrentProjectFile.GetRelativePath(ymap.FilePath));
                    pf.ProjectExplorer?.UpdateYmapTreeNode(ymap);
                    pf.SetProjectHasChanged(true);

                    var result = new JObject
                    {
                        ["success"] = true,
                        ["path"] = filepath,
                        ["bytes"] = data.Length,
                        ["entityCount"] = ymap.AllEntities?.Length ?? 0,
                    };
                    if (ymap.SaveWarnings != null && ymap.SaveWarnings.Count > 0)
                    {
                        result["warnings"] = new JArray(ymap.SaveWarnings);
                    }
                    return result;
                }
                catch (Exception ex)
                {
                    return Fail(ex.Message);
                }
            });
        }
    }
}
