using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using SharpDX;
using Color = System.Drawing.Color;
using Point = System.Drawing.Point;
using RectangleF = System.Drawing.RectangleF;
using Rectangle = System.Drawing.Rectangle;

namespace CodeWalker.LocalApi
{
    // What the annotation layer needs to know about a prop, captured on the UI thread.
    public class LookProp
    {
        public int Id;
        public string Name;
        public EntityBox Box;
        public Vector3 Front;   // world direction the prop's front faces
        public string Status;  // "problem", "ok" or "unchecked"
    }

    // Turns a captured frame into an annotated JPEG for the agent: prop boxes labelled with ids, an arrow
    // for each prop's front, a north arrow and a caption.
    public static class SceneLook
    {
        public const int OutputWidth = 1024;

        static readonly Color ProblemColor = Color.FromArgb(235, 80, 70);
        static readonly Color OkColor = Color.FromArgb(70, 200, 120);
        static readonly Color UncheckedColor = Color.FromArgb(200, 200, 200);

        public static byte[] Render(CapturedFrame frame, IList<LookProp> props, Vector3 sceneCenter, string caption, int quality = 85)
        {
            using (var full = ToBitmap(frame))
            {
                float scale = Math.Min(1f, (float)OutputWidth / frame.Width);
                int w = (int)Math.Round(frame.Width * scale), h = (int)Math.Round(frame.Height * scale);
                using (var image = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                using (var g = Graphics.FromImage(image))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                    g.DrawImage(full, 0, 0, w, h);

                    PointF? Project(Vector3 world)
                    {
                        var clip = Vector4.Transform(new Vector4(world - frame.CameraPosition, 1f), frame.ViewProjection);
                        if (clip.W <= 0.01f) return null; // behind the camera
                        return new PointF((clip.X / clip.W * 0.5f + 0.5f) * w, (0.5f - clip.Y / clip.W * 0.5f) * h);
                    }

                    // Far props first so near labels end up on top.
                    foreach (var prop in props.OrderByDescending(p => Vector3.DistanceSquared(p.Box.Center, frame.CameraPosition)))
                    {
                        DrawProp(g, prop, Project, w, h);
                    }
                    DrawNorthArrow(g, Project, sceneCenter, w);
                    DrawCaption(g, caption, w, h);

                    return EncodeJpeg(image, quality);
                }
            }
        }

        static Bitmap ToBitmap(CapturedFrame frame)
        {
            var bitmap = new Bitmap(frame.Width, frame.Height, PixelFormat.Format32bppArgb);
            var data = bitmap.LockBits(new Rectangle(0, 0, frame.Width, frame.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                for (int y = 0; y < frame.Height; y++)
                {
                    Marshal.Copy(frame.Bgra, y * frame.Width * 4, data.Scan0 + y * data.Stride, frame.Width * 4);
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            return bitmap;
        }

        static void DrawProp(Graphics g, LookProp prop, Func<Vector3, PointF?> project, int w, int h)
        {
            var box = prop.Box;
            var corners = new List<PointF>();
            foreach (int sx in new[] { -1, 1 })
            foreach (int sy in new[] { -1, 1 })
            foreach (int sz in new[] { -1, 1 })
            {
                var p = project(box.ToWorld(new Vector3(sx * box.Half.X, sy * box.Half.Y, sz * box.Half.Z)));
                if (p.HasValue) corners.Add(p.Value);
            }
            if (corners.Count < 8) return; // partly behind the camera
            var rect = RectangleF.FromLTRB(corners.Min(c => c.X), corners.Min(c => c.Y), corners.Max(c => c.X), corners.Max(c => c.Y));
            if (rect.Right < 0 || rect.Bottom < 0 || rect.Left > w || rect.Top > h) return; // off screen

            Color color = prop.Status == "problem" ? ProblemColor : prop.Status == "ok" ? OkColor : UncheckedColor;

            // The footprint on the ground (rotated rectangle) shows orientation and the real area covered,
            // which a screen-aligned box around a rotated prop exaggerates.
            var footprint = new[]
            {
                project(box.ToWorld(new Vector3(-box.Half.X, -box.Half.Y, -box.Half.Z))),
                project(box.ToWorld(new Vector3(box.Half.X, -box.Half.Y, -box.Half.Z))),
                project(box.ToWorld(new Vector3(box.Half.X, box.Half.Y, -box.Half.Z))),
                project(box.ToWorld(new Vector3(-box.Half.X, box.Half.Y, -box.Half.Z))),
            };
            if (footprint.All(p => p.HasValue))
            {
                using (var fill = new SolidBrush(Color.FromArgb(45, color)))
                using (var pen = new Pen(color, 2f))
                {
                    var polygon = footprint.Select(p => p.Value).ToArray();
                    g.FillPolygon(fill, polygon);
                    g.DrawPolygon(pen, polygon);
                }
            }

            // Front arrow from the base centre: long enough to read, capped so big props don't cross the image.
            Vector3 baseCenter = box.ToWorld(new Vector3(0, 0, -box.Half.Z * 0.6f));
            float arrowLength = Math.Min(Math.Max(Math.Max(box.Half.X, box.Half.Y) * 1.3f, 0.5f), 2f);
            var from = project(baseCenter);
            var to = project(baseCenter + prop.Front * arrowLength);
            if (from.HasValue && to.HasValue)
            {
                using (var pen = new Pen(Color.FromArgb(255, 220, 60), 3f) { CustomEndCap = new AdjustableArrowCap(4, 4) })
                {
                    g.DrawLine(pen, from.Value, to.Value);
                }
            }

            string label = "#" + prop.Id;
            using (var font = new Font("Segoe UI", 11f, FontStyle.Bold, GraphicsUnit.Pixel))
            {
                var size = g.MeasureString(label, font);
                // Above the top of the prop at its centre: a screen box corner can sit far from rotated props.
                var anchor = project(box.ToWorld(new Vector3(0, 0, box.Half.Z)));
                float ax = anchor.HasValue ? anchor.Value.X - size.Width / 2 : rect.X;
                float ay = anchor.HasValue ? anchor.Value.Y - size.Height - 2 : rect.Y - size.Height - 1;
                float lx = Math.Max(0, Math.Min(ax, w - size.Width - 2));
                float ly = Math.Max(0, Math.Min(ay, h - size.Height));
                using (var bg = new SolidBrush(Color.FromArgb(200, 0, 0, 0)))
                using (var fg = new SolidBrush(color))
                {
                    g.FillRectangle(bg, lx, ly, size.Width + 2, size.Height);
                    g.DrawString(label, font, fg, lx + 1, ly);
                }
            }
        }

        static void DrawNorthArrow(Graphics g, Func<Vector3, PointF?> project, Vector3 center, int w)
        {
            var a = project(center);
            var b = project(center + Vector3.UnitY * 5f);
            if (!a.HasValue || !b.HasValue) return;
            float dx = b.Value.X - a.Value.X, dy = b.Value.Y - a.Value.Y;
            float len = (float)Math.Sqrt(dx * dx + dy * dy);
            if (len < 0.5f) return; // looking straight along north
            dx /= len; dy /= len;

            var origin = new PointF(w - 40, 44);
            using (var bg = new SolidBrush(Color.FromArgb(170, 0, 0, 0)))
            {
                g.FillEllipse(bg, origin.X - 30, origin.Y - 30, 60, 60);
            }
            using (var pen = new Pen(Color.White, 3f) { CustomEndCap = new AdjustableArrowCap(5, 5) })
            {
                g.DrawLine(pen, origin.X - dx * 18, origin.Y - dy * 18, origin.X + dx * 18, origin.Y + dy * 18);
            }
            using (var font = new Font("Segoe UI", 12f, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var brush = new SolidBrush(Color.White))
            {
                g.DrawString("N", font, brush, origin.X + dx * 22 - 5, origin.Y + dy * 22 - 8);
            }
        }

        static void DrawCaption(Graphics g, string caption, int w, int h)
        {
            using (var font = new Font("Segoe UI", 13f, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var bg = new SolidBrush(Color.FromArgb(190, 0, 0, 0)))
            using (var fg = new SolidBrush(Color.White))
            {
                var size = g.MeasureString(caption, font, w - 12);
                g.FillRectangle(bg, 0, h - size.Height - 8, w, size.Height + 8);
                g.DrawString(caption, font, fg, new RectangleF(6, h - size.Height - 4, w - 12, size.Height + 4));
            }
        }

        static byte[] EncodeJpeg(Bitmap image, int quality)
        {
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
            using (var parameters = new EncoderParameters(1))
            using (var stream = new MemoryStream())
            {
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                image.Save(stream, codec, parameters);
                return stream.ToArray();
            }
        }
    }
}
