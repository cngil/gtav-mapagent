using System;
using System.Runtime.InteropServices;

namespace CodeWalker.LocalApi
{
    // Win32 helpers for hosting the WorldForm as a child window inside another process's window
    // (the Electron editor), so the 3D view appears as part of that app.
    public static class EmbedHost
    {
        const int GWL_STYLE = -16;
        const long WS_CHILD = 0x40000000L;
        const long WS_POPUP = 0x80000000L;
        const long WS_CAPTION = 0x00C00000L;
        const long WS_THICKFRAME = 0x00040000L;
        const long WS_SYSMENU = 0x00080000L;
        const long WS_MINIMIZEBOX = 0x00020000L;
        const long WS_MAXIMIZEBOX = 0x00010000L;
        const long WS_CLIPSIBLINGS = 0x04000000L;

        static readonly IntPtr HWND_TOP = IntPtr.Zero;
        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOACTIVATE = 0x0010;
        const uint SWP_FRAMECHANGED = 0x0020;
        const uint SWP_SHOWWINDOW = 0x0040;

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
        static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern IntPtr SetFocus(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern IntPtr GetFocus();

        static long GetStyle(IntPtr hWnd)
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, GWL_STYLE).ToInt64() : GetWindowLong32(hWnd, GWL_STYLE);
        }

        static void SetStyle(IntPtr hWnd, long style)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, GWL_STYLE, new IntPtr(style));
            else SetWindowLong32(hWnd, GWL_STYLE, unchecked((int)style));
        }

        public static void Attach(IntPtr child, IntPtr parent)
        {
            long style = GetStyle(child);
            style &= ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
            style |= WS_CHILD | WS_CLIPSIBLINGS;
            SetStyle(child, style);
            if (SetParent(child, parent) == IntPtr.Zero)
            {
                throw new InvalidOperationException("SetParent failed, Win32 error " + Marshal.GetLastWin32Error());
            }
            // Keep the current size: the renderer's post-processing buffers are 1/8 of the window,
            // so a tiny window gives zero-sized buffers and crashes the render thread.
            SetWindowPos(child, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }

        // See Attach: anything under 8px breaks post-processing, keep a safe margin.
        const int MinSize = 64;

        // Coordinates are physical pixels relative to the parent's client area.
        public static void SetBounds(IntPtr child, int x, int y, int width, int height)
        {
            SetWindowPos(child, HWND_TOP, x, y, Math.Max(MinSize, width), Math.Max(MinSize, height), SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }

        // Windows routes clicks to a child window of another process but leaves keyboard focus with
        // the host, so the child has to take focus explicitly.
        public static void Focus(IntPtr hWnd)
        {
            SetFocus(hWnd);
        }

        // The reverse direction: once the child holds focus, clicking the host's own content doesn't
        // take it back (the host thinks it already has it). Handing focus to the host's top-level
        // window makes it redistribute focus to its content, like Alt+Tab does. No-op otherwise, so
        // ordinary clicks in the host don't bounce its focus.
        public static void ReleaseFocus(IntPtr child, IntPtr parent)
        {
            if (GetFocus() == child) SetFocus(parent);
        }

        public static bool IsAlive(IntPtr hWnd)
        {
            return IsWindow(hWnd);
        }
    }
}
