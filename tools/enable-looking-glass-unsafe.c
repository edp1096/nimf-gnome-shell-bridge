#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

typedef struct
{
  unsigned short code;
  int shift;
} Key;

static int
emit (int fd, unsigned short type, unsigned short code, int value)
{
  struct input_event event = { 0 };
  ssize_t written;

  event.type = type;
  event.code = code;
  event.value = value;

  do
    written = write (fd, &event, sizeof event);
  while (written < 0 && errno == EINTR);

  return written == (ssize_t) sizeof event ? 0 : -1;
}

static int
sync_event (int fd)
{
  return emit (fd, EV_SYN, SYN_REPORT, 0);
}

static int
key_event (int fd, unsigned short code, int value)
{
  if (emit (fd, EV_KEY, code, value) < 0)
    return -1;
  return sync_event (fd);
}

static int
tap (int fd, unsigned short code)
{
  if (key_event (fd, code, 1) < 0)
    return -1;
  usleep (12000);
  if (key_event (fd, code, 0) < 0)
    return -1;
  usleep (12000);
  return 0;
}

static Key
ascii_key (char character)
{
  static const unsigned short letters[] = {
    KEY_A, KEY_B, KEY_C, KEY_D, KEY_E, KEY_F, KEY_G,
    KEY_H, KEY_I, KEY_J, KEY_K, KEY_L, KEY_M, KEY_N,
    KEY_O, KEY_P, KEY_Q, KEY_R, KEY_S, KEY_T, KEY_U,
    KEY_V, KEY_W, KEY_X, KEY_Y, KEY_Z,
  };

  if (character >= 'a' && character <= 'z')
    return (Key) { letters[character - 'a'], 0 };
  if (character >= 'A' && character <= 'Z')
    return (Key) { letters[character - 'A'], 1 };

  switch (character)
    {
    case '.': return (Key) { KEY_DOT, 0 };
    case '_': return (Key) { KEY_MINUS, 1 };
    case '=': return (Key) { KEY_EQUAL, 0 };
    default: return (Key) { 0, 0 };
    }
}

static int
type_text (int fd, const char *text)
{
  for (; *text; text++)
    {
      Key key = ascii_key (*text);

      if (!key.code)
        {
          fprintf (stderr, "Unsupported character: %c\n", *text);
          return -1;
        }

      if (key.shift && key_event (fd, KEY_LEFTSHIFT, 1) < 0)
        return -1;
      if (tap (fd, key.code) < 0)
        return -1;
      if (key.shift && key_event (fd, KEY_LEFTSHIFT, 0) < 0)
        return -1;
    }

  return 0;
}

int
main (void)
{
  const char command[] = "global.context.unsafe_mode=true";
  struct uinput_setup setup = { 0 };
  int fd;
  int code;
  int result = EXIT_FAILURE;

  fd = open ("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (fd < 0)
    {
      perror ("open /dev/uinput");
      return EXIT_FAILURE;
    }

  if (ioctl (fd, UI_SET_EVBIT, EV_KEY) < 0 ||
      ioctl (fd, UI_SET_EVBIT, EV_SYN) < 0)
    goto fail;

  for (code = 0; code <= KEY_MAX; code++)
    if (ioctl (fd, UI_SET_KEYBIT, code) < 0)
      goto fail;

  snprintf (setup.name, UINPUT_MAX_NAME_SIZE, "Codex one-shot keyboard");
  setup.id.bustype = BUS_USB;
  setup.id.vendor = 0x1209;
  setup.id.product = 0x0001;
  setup.id.version = 1;

  if (ioctl (fd, UI_DEV_SETUP, &setup) < 0 ||
      ioctl (fd, UI_DEV_CREATE) < 0)
    goto fail;

  usleep (3000000);

  if (tap (fd, KEY_ESC) < 0 || tap (fd, KEY_ESC) < 0)
    goto destroy;
  usleep (200000);

  if (key_event (fd, KEY_LEFTALT, 1) < 0 ||
      tap (fd, KEY_F2) < 0 ||
      key_event (fd, KEY_LEFTALT, 0) < 0)
    goto destroy;
  usleep (400000);

  if (type_text (fd, "lg") < 0 || tap (fd, KEY_ENTER) < 0)
    goto destroy;
  usleep (800000);

  if (type_text (fd, command) < 0 || tap (fd, KEY_ENTER) < 0)
    goto destroy;
  usleep (2000000);
  result = EXIT_SUCCESS;

destroy:
  ioctl (fd, UI_DEV_DESTROY);
  close (fd);
  return result;

fail:
  perror ("configure /dev/uinput");
  close (fd);
  return EXIT_FAILURE;
}
