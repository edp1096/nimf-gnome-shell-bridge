#ifndef NIMF_LEGACY_H
#define NIMF_LEGACY_H

#include <glib.h>

/*
 * Compatibility declarations for the installed
 * nimf_2022.03.05-bullseye_arm64 package.
 *
 * This package predates Nimf's current GObject API and does not ship
 * development headers.  The declarations below were verified against both
 * libnimf.so.2.0.0 and im-nimf-gtk3.so on this machine.  Do not replace these
 * declarations with headers from a newer Nimf checkout: that API is ABI
 * incompatible with the installed library.
 */

typedef struct _NimfIM NimfIM;

typedef enum
{
  NIMF_LEGACY_EVENT_NOTHING = -1,
  NIMF_LEGACY_EVENT_KEY_PRESS = 0,
  NIMF_LEGACY_EVENT_KEY_RELEASE = 1,
} NimfLegacyEventType;

typedef struct
{
  NimfLegacyEventType type;
  guint32 state;
  guint32 keyval;
  guint32 hardware_keycode;
} NimfLegacyEvent;

typedef struct
{
  gint x;
  gint y;
  gint width;
  gint height;
} NimfLegacyRectangle;

typedef enum
{
  NIMF_LEGACY_CALLBACK_PREEDIT_START = 0,
  NIMF_LEGACY_CALLBACK_PREEDIT_END = 1,
  NIMF_LEGACY_CALLBACK_PREEDIT_CHANGED = 2,
  NIMF_LEGACY_CALLBACK_COMMIT = 3,
  NIMF_LEGACY_CALLBACK_RETRIEVE_SURROUNDING = 4,
  NIMF_LEGACY_CALLBACK_DELETE_SURROUNDING = 5,
  NIMF_LEGACY_CALLBACK_BEEP = 6,
} NimfLegacyCallbackType;

NimfIM *nimf_im_new (void);
void nimf_im_free (NimfIM *im);
void nimf_im_focus_in (NimfIM *im);
void nimf_im_focus_out (NimfIM *im);
void nimf_im_reset (NimfIM *im);
gboolean nimf_im_filter_event (NimfIM *im, NimfLegacyEvent *event);
void nimf_im_get_preedit_info (NimfIM *im,
                               gchar **text,
                               gpointer *attrs,
                               gint *cursor_pos);
void nimf_im_set_callback (NimfIM *im,
                           NimfLegacyCallbackType type,
                           gpointer callback,
                           gpointer user_data);
void nimf_im_set_cursor_location (NimfIM *im,
                                  const NimfLegacyRectangle *area);
void nimf_im_set_surrounding (NimfIM *im,
                              const gchar *text,
                              gint len,
                              gint cursor_index);
void nimf_im_set_use_preedit (NimfIM *im, gboolean use_preedit);

#endif
