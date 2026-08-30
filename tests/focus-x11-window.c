#include <X11/Xlib.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

int
main (int argc, char **argv)
{
  Display *display;
  Window window;
  Atom active_window;
  XEvent event = { 0 };
  char *end = NULL;
  unsigned long width = 0;
  unsigned long height = 0;

  if (argc != 2 && argc != 4)
    {
      fprintf (stderr, "usage: %s WINDOW_ID [WIDTH HEIGHT]\n", argv[0]);
      return EXIT_FAILURE;
    }

  errno = 0;
  window = (Window) strtoul (argv[1], &end, 0);
  if (errno != 0 || !end || *end != '\0')
    {
      fprintf (stderr, "invalid X11 window id: %s\n", argv[1]);
      return EXIT_FAILURE;
    }

  if (argc == 4)
    {
      errno = 0;
      width = strtoul (argv[2], &end, 10);
      if (errno != 0 || !end || *end != '\0' || width == 0)
        {
          fprintf (stderr, "invalid width: %s\n", argv[2]);
          return EXIT_FAILURE;
        }
      errno = 0;
      height = strtoul (argv[3], &end, 10);
      if (errno != 0 || !end || *end != '\0' || height == 0)
        {
          fprintf (stderr, "invalid height: %s\n", argv[3]);
          return EXIT_FAILURE;
        }
    }

  display = XOpenDisplay (NULL);
  if (!display)
    {
      fprintf (stderr, "could not open X11 display\n");
      return EXIT_FAILURE;
    }

  active_window = XInternAtom (display, "_NET_ACTIVE_WINDOW", False);
  event.xclient.type = ClientMessage;
  event.xclient.window = window;
  event.xclient.message_type = active_window;
  event.xclient.format = 32;
  event.xclient.data.l[0] = 2;
  event.xclient.data.l[1] = CurrentTime;
  XSendEvent (display,
              DefaultRootWindow (display),
              False,
              SubstructureRedirectMask | SubstructureNotifyMask,
              &event);
  XRaiseWindow (display, window);
  XSetInputFocus (display, window, RevertToParent, CurrentTime);
  if (argc == 4)
    XResizeWindow (display, window, (unsigned int) width, (unsigned int) height);
  XSync (display, False);
  XCloseDisplay (display);
  return EXIT_SUCCESS;
}
