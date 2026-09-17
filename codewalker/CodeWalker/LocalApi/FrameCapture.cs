using System;
using System.Threading.Tasks;
using SharpDX;
using SharpDX.Direct3D11;
using SharpDX.DXGI;
using CodeWalker.World;
using Device = SharpDX.Direct3D11.Device;

namespace CodeWalker.LocalApi
{
    // One rendered frame read back from the GPU, plus the camera it was rendered with.
    public class CapturedFrame
    {
        public int Width;
        public int Height;
        public byte[] Bgra;              // top-down rows, 4 bytes per pixel, alpha forced opaque
        public Matrix ViewProjection;    // CodeWalker renders camera-relative: project (world - CameraPosition)
        public Vector3 CameraPosition;
    }

    // Grabs the next frame the renderer draws. Requests come from any thread; the read-back happens on
    // the render thread (the D3D11 immediate context isn't thread-safe) right before Present, since
    // with SwapEffect.Discard the back buffer's contents are undefined afterwards.
    public class FrameCapture
    {
        readonly object gate = new object();
        TaskCompletionSource<CapturedFrame> pending;

        public Task<CapturedFrame> RequestNextFrame()
        {
            lock (gate)
            {
                if (pending == null)
                {
                    pending = new TaskCompletionSource<CapturedFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
                }
                return pending.Task;
            }
        }

        // Render thread only.
        public void OnFrameRendered(DeviceContext context, Texture2D backBuffer, Camera camera)
        {
            TaskCompletionSource<CapturedFrame> request;
            lock (gate)
            {
                request = pending;
                pending = null;
            }
            if (request == null) return;

            try
            {
                request.SetResult(ReadBack(context, backBuffer, camera));
            }
            catch (Exception ex)
            {
                request.SetException(ex);
            }
        }

        static CapturedFrame ReadBack(DeviceContext context, Texture2D backBuffer, Camera camera)
        {
            Device device = context.Device;
            var desc = backBuffer.Description;

            // A multisampled buffer can't be copied to a CPU-readable texture directly; resolve it first.
            Texture2D resolved = null;
            Texture2D source = backBuffer;
            if (desc.SampleDescription.Count > 1)
            {
                var resolveDesc = desc;
                resolveDesc.SampleDescription = new SampleDescription(1, 0);
                resolveDesc.Usage = ResourceUsage.Default;
                resolveDesc.BindFlags = BindFlags.None;
                resolveDesc.CpuAccessFlags = CpuAccessFlags.None;
                resolveDesc.OptionFlags = ResourceOptionFlags.None;
                resolved = new Texture2D(device, resolveDesc);
                context.ResolveSubresource(backBuffer, 0, resolved, 0, desc.Format);
                source = resolved;
            }

            var stagingDesc = desc;
            stagingDesc.SampleDescription = new SampleDescription(1, 0);
            stagingDesc.Usage = ResourceUsage.Staging;
            stagingDesc.BindFlags = BindFlags.None;
            stagingDesc.CpuAccessFlags = CpuAccessFlags.Read;
            stagingDesc.OptionFlags = ResourceOptionFlags.None;

            try
            {
                using (var staging = new Texture2D(device, stagingDesc))
                {
                    context.CopyResource(source, staging);
                    var box = context.MapSubresource(staging, 0, MapMode.Read, SharpDX.Direct3D11.MapFlags.None);
                    try
                    {
                        int width = desc.Width, height = desc.Height;
                        var bgra = new byte[width * height * 4];
                        var row = new byte[width * 4];
                        bool rgba = desc.Format == Format.R8G8B8A8_UNorm || desc.Format == Format.R8G8B8A8_UNorm_SRgb;
                        for (int y = 0; y < height; y++)
                        {
                            Utilities.Read(box.DataPointer + y * box.RowPitch, row, 0, row.Length);
                            int o = y * width * 4;
                            for (int x = 0; x < width * 4; x += 4)
                            {
                                bgra[o + x] = rgba ? row[x + 2] : row[x];
                                bgra[o + x + 1] = row[x + 1];
                                bgra[o + x + 2] = rgba ? row[x] : row[x + 2];
                                bgra[o + x + 3] = 255;
                            }
                        }
                        return new CapturedFrame
                        {
                            Width = width,
                            Height = height,
                            Bgra = bgra,
                            ViewProjection = camera.ViewProjMatrix,
                            CameraPosition = camera.Position,
                        };
                    }
                    finally
                    {
                        context.UnmapSubresource(staging, 0);
                    }
                }
            }
            finally
            {
                resolved?.Dispose();
            }
        }
    }
}
