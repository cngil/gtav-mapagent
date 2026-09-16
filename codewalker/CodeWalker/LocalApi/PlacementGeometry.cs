using System;
using System.Collections.Generic;
using SharpDX;
using CodeWalker.GameFiles;

namespace CodeWalker.LocalApi
{
    // Oriented bounding box of a placed entity, built from its archetype's bounding box.
    public struct EntityBox
    {
        public Vector3 Center;
        public Vector3 AxisX, AxisY, AxisZ; // world directions of the prop's local axes
        public Vector3 Half;                // half extents along those axes

        public static bool TryCreate(YmapEntityDef ent, out EntityBox box)
        {
            box = default(EntityBox);
            var arch = ent.Archetype;
            if (arch == null) return false;
            Vector3 size = arch.BBMax - arch.BBMin;
            if (size.X <= 0 || size.Y <= 0 || size.Z <= 0) return false;

            Vector3 scale = ent.Scale;
            Quaternion q = ent.Orientation;
            Vector3 localCenter = (arch.BBMin + arch.BBMax) * 0.5f * scale;
            box.Center = ent.Position + Vector3.Transform(localCenter, q);
            box.AxisX = Vector3.Transform(Vector3.UnitX, q);
            box.AxisY = Vector3.Transform(Vector3.UnitY, q);
            box.AxisZ = Vector3.Transform(Vector3.UnitZ, q);
            box.Half = size * 0.5f * new Vector3(Math.Abs(scale.X), Math.Abs(scale.Y), Math.Abs(scale.Z));
            return true;
        }

        public float BoundingRadius { get { return Half.Length(); } }

        public Vector3 ToWorld(Vector3 local)
        {
            return Center + AxisX * local.X + AxisY * local.Y + AxisZ * local.Z;
        }

        float ProjectedRadius(Vector3 axis)
        {
            return Math.Abs(Vector3.Dot(AxisX, axis)) * Half.X
                 + Math.Abs(Vector3.Dot(AxisY, axis)) * Half.Y
                 + Math.Abs(Vector3.Dot(AxisZ, axis)) * Half.Z;
        }

        // Separating axis test. Returns 0 if the boxes don't intersect. Otherwise returns how far `this`
        // has to move sideways to separate, with the horizontal direction to move in: props rest on the
        // ground, so the shallowest overlap overall (often vertical, e.g. for a sunken prop) isn't a fix.
        public float Penetration(EntityBox other, out Vector3 pushAxis)
        {
            pushAxis = Vector3.Zero;
            if (Vector3.Distance(Center, other.Center) > BoundingRadius + other.BoundingRadius) return 0;

            var axes = new List<Vector3> { AxisX, AxisY, AxisZ, other.AxisX, other.AxisY, other.AxisZ };
            foreach (var a in new[] { AxisX, AxisY, AxisZ })
            {
                foreach (var b in new[] { other.AxisX, other.AxisY, other.AxisZ })
                {
                    Vector3 c = Vector3.Cross(a, b);
                    if (c.LengthSquared() > 1e-6f) axes.Add(Vector3.Normalize(c));
                }
            }

            Vector3 between = Center - other.Center;
            float bestHorizontal = float.MaxValue;
            foreach (var axis in axes)
            {
                float overlap = ProjectedRadius(axis) + other.ProjectedRadius(axis) - Math.Abs(Vector3.Dot(between, axis));
                if (overlap <= 0) return 0;

                Vector3 flat = new Vector3(axis.X, axis.Y, 0);
                float flatLength = flat.Length();
                if (flatLength < 0.3f) continue; // mostly vertical
                // Moving d along the flat direction advances only d * flatLength along the axis.
                float needed = overlap / flatLength;
                if (needed < bestHorizontal)
                {
                    bestHorizontal = needed;
                    flat /= flatLength;
                    pushAxis = Vector3.Dot(between, flat) >= 0 ? flat : -flat;
                }
            }
            if (bestHorizontal == float.MaxValue)
            {
                // Degenerate (no usable horizontal axis): push apart along the line between centres.
                Vector3 flat = new Vector3(between.X, between.Y, 0);
                pushAxis = flat.LengthSquared() > 1e-6f ? Vector3.Normalize(flat) : Vector3.UnitX;
                return Half.Length();
            }
            return bestHorizontal;
        }

        // Spheres filling the box, kept `floorClearance` above its bottom face so that resting on the
        // ground doesn't register as a collision. At most ~maxSamples spheres.
        public List<BoundingSphere> InteriorSpheres(float floorClearance, int maxSamples, out float radius)
        {
            var result = new List<BoundingSphere>();
            float r = Math.Max(0.08f, Math.Min(Math.Min(Half.X, Half.Y), Half.Z) * 0.8f);
            r = Math.Min(r, 0.6f);

            Vector3 spacing = new Vector3(r * 1.5f);
            // Coarsen the grid for large props.
            for (int guard = 0; guard < 20; guard++)
            {
                int count = Steps(Half.X, r, spacing.X) * Steps(Half.Y, r, spacing.Y) * StepsZ(Half.Z, r, spacing.Z, floorClearance);
                if (count <= maxSamples) break;
                spacing *= 1.25f;
            }

            int nx = Steps(Half.X, r, spacing.X), ny = Steps(Half.Y, r, spacing.Y), nz = StepsZ(Half.Z, r, spacing.Z, floorClearance);
            float zMin = -Half.Z + floorClearance + r;
            float zMax = Half.Z - r;
            for (int ix = 0; ix < nx; ix++)
            for (int iy = 0; iy < ny; iy++)
            for (int iz = 0; iz < nz; iz++)
            {
                var local = new Vector3(Lerp(-Half.X + r, Half.X - r, nx, ix), Lerp(-Half.Y + r, Half.Y - r, ny, iy), Lerp(zMin, Math.Max(zMin, zMax), nz, iz));
                // Slightly smaller than the grid radius, so a prop resting flush against a wall doesn't count.
                result.Add(new BoundingSphere(ToWorld(local), r * 0.85f));
            }
            radius = r;
            return result;
        }

        static int StepsZ(float halfZ, float r, float spacing, float clearance)
        {
            float usable = 2 * halfZ - clearance - r * 1.5f;
            return usable <= 0 ? 1 : 1 + (int)Math.Floor(usable / spacing);
        }

        static int Steps(float half, float r, float spacing)
        {
            float usable = 2 * half - 2 * r;
            return usable <= 0 ? 1 : 1 + (int)Math.Floor(usable / spacing);
        }

        static float Lerp(float a, float b, int n, int i)
        {
            return n <= 1 ? (a + b) * 0.5f : a + (b - a) * i / (n - 1);
        }

        // Bottom-face corners (world space).
        public Vector3[] BottomCorners()
        {
            return new[]
            {
                ToWorld(new Vector3(-Half.X, -Half.Y, -Half.Z)),
                ToWorld(new Vector3(Half.X, -Half.Y, -Half.Z)),
                ToWorld(new Vector3(Half.X, Half.Y, -Half.Z)),
                ToWorld(new Vector3(-Half.X, Half.Y, -Half.Z)),
            };
        }
    }
}
