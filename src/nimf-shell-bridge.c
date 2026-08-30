#include <gio/gio.h>
#include <glib-unix.h>
#include <stdlib.h>
#include <string.h>

#include "nimf-legacy.h"

#define BUS_NAME "org.nimf.ShellBridge"
#define OBJECT_PATH "/org/nimf/ShellBridge"
#define INTERFACE_NAME "org.nimf.ShellBridge1"
#define NIMF_MODIFIER_MASK 0x5c001fffU
/* Fallback only: Reset/FocusOut normally resolves a deferred commit first. */
#define COMMIT_SETTLE_TIMEOUT_MS 20

typedef struct
{
  GMainLoop *loop;
  GDBusConnection *connection;
  GDBusNodeInfo *introspection;
  guint registration_id;
  guint owner_id;
  NimfIM *im;
  gchar *surrounding_text;
  gchar *transition_commit;
  gchar *deferred_commit;
  gint surrounding_cursor;
  gboolean focused;
  gboolean preedit_visible;
  gboolean transition_in_progress;
  gboolean filtering_key_event;
  gboolean deferred_preedit;
  guint deferred_commit_timeout_id;
  guint focus_generation;
  gint exit_status;
} Bridge;

static const gchar introspection_xml[] =
  "<node>"
  " <interface name='" INTERFACE_NAME "'>"
  "  <method name='Ping'>"
  "   <arg name='bridge_version' type='s' direction='out'/>"
  "   <arg name='nimf_abi' type='s' direction='out'/>"
  "  </method>"
  "  <method name='FocusIn'/>"
  "  <method name='FocusOut'/>"
  "  <method name='FocusOutSync'>"
  "   <arg name='committed_text' type='s' direction='out'/>"
  "  </method>"
  "  <method name='Reset'/>"
  "  <method name='ResetSync'>"
  "   <arg name='committed_text' type='s' direction='out'/>"
  "  </method>"
  "  <method name='SetCursorLocation'>"
  "   <arg name='x' type='i' direction='in'/>"
  "   <arg name='y' type='i' direction='in'/>"
  "   <arg name='width' type='i' direction='in'/>"
  "   <arg name='height' type='i' direction='in'/>"
  "  </method>"
  "  <method name='SetSurrounding'>"
  "   <arg name='text' type='s' direction='in'/>"
  "   <arg name='cursor' type='u' direction='in'/>"
  "   <arg name='anchor' type='u' direction='in'/>"
  "  </method>"
  "  <method name='SetUsePreedit'>"
  "   <arg name='enabled' type='b' direction='in'/>"
  "  </method>"
  "  <method name='FilterKeyEvent'>"
  "   <arg name='keyval' type='u' direction='in'/>"
  "   <arg name='hardware_keycode' type='u' direction='in'/>"
  "   <arg name='state' type='u' direction='in'/>"
  "   <arg name='focus_generation' type='u' direction='in'/>"
  "   <arg name='press' type='b' direction='in'/>"
  "   <arg name='handled' type='b' direction='out'/>"
  "  </method>"
  "  <signal name='Commit'>"
  "   <arg name='text' type='s'/>"
  "   <arg name='focus_generation' type='u'/>"
  "  </signal>"
  "  <signal name='Preedit'>"
  "   <arg name='text' type='s'/>"
  "   <arg name='cursor' type='u'/>"
  "   <arg name='visible' type='b'/>"
  "   <arg name='focus_generation' type='u'/>"
  "  </signal>"
  "  <signal name='DeleteSurrounding'>"
  "   <arg name='offset' type='i'/>"
  "   <arg name='n_chars' type='u'/>"
  "   <arg name='focus_generation' type='u'/>"
  "  </signal>"
  "  <signal name='RequestSurrounding'>"
  "   <arg name='focus_generation' type='u'/>"
  "  </signal>"
  "  <signal name='Beep'>"
  "   <arg name='focus_generation' type='u'/>"
  "  </signal>"
  " </interface>"
  "</node>";

static gboolean
emit_signal (Bridge *bridge, const gchar *name, GVariant *parameters)
{
  g_autoptr (GError) error = NULL;

  if (!bridge->connection)
    return FALSE;

  if (!g_dbus_connection_emit_signal (bridge->connection,
                                      NULL,
                                      OBJECT_PATH,
                                      INTERFACE_NAME,
                                      name,
                                      parameters,
                                      &error))
    {
      g_warning ("Could not emit %s: %s", name, error->message);
      return FALSE;
    }

  return TRUE;
}

static void emit_preedit (Bridge *bridge, gboolean visible);

static void
emit_commit (Bridge *bridge, const gchar *text)
{
  emit_signal (bridge,
               "Commit",
               g_variant_new ("(su)",
                              text ? text : "",
                              bridge->focus_generation));
}

static void
discard_deferred_commit (Bridge *bridge)
{
  if (bridge->deferred_commit_timeout_id)
    g_source_remove (bridge->deferred_commit_timeout_id);
  bridge->deferred_commit_timeout_id = 0;
  bridge->deferred_preedit = FALSE;
  g_clear_pointer (&bridge->deferred_commit, g_free);
}

static void
flush_deferred_commit (Bridge *bridge, gboolean flush_preedit)
{
  g_autofree gchar *text = NULL;
  gboolean preedit_pending;

  if (bridge->deferred_commit_timeout_id)
    g_source_remove (bridge->deferred_commit_timeout_id);
  bridge->deferred_commit_timeout_id = 0;
  text = g_steal_pointer (&bridge->deferred_commit);
  preedit_pending = bridge->deferred_preedit;
  bridge->deferred_preedit = FALSE;

  if (text)
    emit_commit (bridge, text);
  if (flush_preedit && preedit_pending)
    emit_preedit (bridge, bridge->preedit_visible);
}

static gboolean
deferred_commit_timeout_cb (gpointer user_data)
{
  Bridge *bridge = user_data;

  bridge->deferred_commit_timeout_id = 0;
  flush_deferred_commit (bridge, TRUE);
  return G_SOURCE_REMOVE;
}

static void
emit_preedit (Bridge *bridge, gboolean visible)
{
  gchar *text = NULL;
  gint cursor = 0;

  if (bridge->transition_in_progress)
    return;

  if (visible)
    nimf_im_get_preedit_info (bridge->im, &text, NULL, &cursor);

  if (!text)
    text = calloc (1, 1);

  if (bridge->deferred_commit)
    {
      if (!visible || text[0] == '\0')
        {
          bridge->deferred_preedit = TRUE;
          free (text);
          return;
        }

      flush_deferred_commit (bridge, FALSE);
    }

  emit_signal (bridge,
               "Preedit",
               g_variant_new ("(subu)",
                              text,
                              (guint) MAX (cursor, 0),
                              visible,
                              bridge->focus_generation));
  free (text);
}

static void
on_preedit_start (NimfIM *im, Bridge *bridge)
{
  (void) im;
  bridge->preedit_visible = TRUE;
  emit_preedit (bridge, TRUE);
}

static void
on_preedit_end (NimfIM *im, Bridge *bridge)
{
  (void) im;
  bridge->preedit_visible = FALSE;
  emit_preedit (bridge, FALSE);
}

static void
on_preedit_changed (NimfIM *im, Bridge *bridge)
{
  (void) im;
  emit_preedit (bridge, bridge->preedit_visible);
}

static void
on_commit (NimfIM *im, const gchar *text, Bridge *bridge)
{
  (void) im;

  if (bridge->transition_in_progress)
    {
      gchar *combined = g_strconcat (bridge->transition_commit ?: "",
                                     text ?: "",
                                     NULL);

      g_free (bridge->transition_commit);
      bridge->transition_commit = combined;
      return;
    }

  if (bridge->filtering_key_event)
    {
      /* A commit produced synchronously by a key is ordinary input. */
      emit_commit (bridge, text);
      return;
    }

  /*
   * Nimf can commit the last preedit just before Mutter sends Reset while a
   * pointer focus change is in flight. Mutter's COMMIT reset mode has already
   * put that text in the old client, so wait for the ordering event instead
   * of forwarding this possible duplicate to whichever client is focused
   * next. Candidate-click and other genuine out-of-key commits are released
   * by a following preedit or by the short fallback timer.
   */
  {
    gchar *combined = g_strconcat (bridge->deferred_commit ?: "",
                                   text ?: "",
                                   NULL);

    g_free (bridge->deferred_commit);
    bridge->deferred_commit = combined;
  }
  if (bridge->deferred_commit_timeout_id)
    g_source_remove (bridge->deferred_commit_timeout_id);
  bridge->deferred_commit_timeout_id =
    g_timeout_add (COMMIT_SETTLE_TIMEOUT_MS,
                   deferred_commit_timeout_cb,
                   bridge);
}

static gboolean
on_retrieve_surrounding (NimfIM *im, Bridge *bridge)
{
  if (bridge->surrounding_text)
    {
      nimf_im_set_surrounding (im,
                               bridge->surrounding_text,
                               (gint) strlen (bridge->surrounding_text),
                               bridge->surrounding_cursor);
      return TRUE;
    }

  emit_signal (bridge,
               "RequestSurrounding",
               g_variant_new ("(u)", bridge->focus_generation));
  return FALSE;
}

static gboolean
on_delete_surrounding (NimfIM *im,
                       gint offset,
                       gint n_chars,
                       Bridge *bridge)
{
  (void) im;

  if (n_chars < 0)
    return FALSE;

  return emit_signal (bridge,
                      "DeleteSurrounding",
                      g_variant_new ("(iuu)",
                                     offset,
                                     (guint) n_chars,
                                     bridge->focus_generation));
}

static void
on_beep (NimfIM *im, Bridge *bridge)
{
  (void) im;
  emit_signal (bridge,
               "Beep",
               g_variant_new ("(u)", bridge->focus_generation));
}

static gint
byte_cursor_to_character_cursor (const gchar *text, guint cursor)
{
  gsize length = strlen (text);
  gsize clamped = MIN ((gsize) cursor, length);

  while (clamped > 0 && (((guchar) text[clamped]) & 0xc0U) == 0x80U)
    clamped--;

  return (gint) g_utf8_pointer_to_offset (text, text + clamped);
}

static void
return_void (GDBusMethodInvocation *invocation)
{
  g_dbus_method_invocation_return_value (invocation, NULL);
}

static void
begin_transition (Bridge *bridge)
{
  discard_deferred_commit (bridge);
  g_clear_pointer (&bridge->transition_commit, g_free);
  bridge->transition_in_progress = TRUE;
}

static void
return_transition_commit (Bridge *bridge,
                          GDBusMethodInvocation *invocation)
{
  bridge->transition_in_progress = FALSE;
  g_dbus_method_invocation_return_value (
    invocation,
    g_variant_new ("(s)", bridge->transition_commit ?: ""));
  g_clear_pointer (&bridge->transition_commit, g_free);
}

static void
handle_method_call (GDBusConnection *connection,
                    const gchar *sender,
                    const gchar *object_path,
                    const gchar *interface_name,
                    const gchar *method_name,
                    GVariant *parameters,
                    GDBusMethodInvocation *invocation,
                    gpointer user_data)
{
  Bridge *bridge = user_data;

  (void) connection;
  (void) sender;
  (void) object_path;
  (void) interface_name;

  if (g_str_equal (method_name, "Ping"))
    {
      g_dbus_method_invocation_return_value (
        invocation,
        g_variant_new ("(ss)", "2", "nimf-2022.03.05-legacy"));
    }
  else if (g_str_equal (method_name, "FocusIn"))
    {
      if (!bridge->focused)
        {
          nimf_im_focus_in (bridge->im);
          bridge->focused = TRUE;
        }
      return_void (invocation);
    }
  else if (g_str_equal (method_name, "FocusOut"))
    {
      begin_transition (bridge);
      if (bridge->focused)
        {
          nimf_im_focus_out (bridge->im);
          bridge->focused = FALSE;
        }
      bridge->preedit_visible = FALSE;
      bridge->transition_in_progress = FALSE;
      g_clear_pointer (&bridge->transition_commit, g_free);
      return_void (invocation);
    }
  else if (g_str_equal (method_name, "FocusOutSync"))
    {
      begin_transition (bridge);
      if (bridge->focused)
        {
          nimf_im_focus_out (bridge->im);
          bridge->focused = FALSE;
        }
      bridge->preedit_visible = FALSE;
      return_transition_commit (bridge, invocation);
    }
  else if (g_str_equal (method_name, "Reset"))
    {
      begin_transition (bridge);
      nimf_im_reset (bridge->im);
      bridge->preedit_visible = FALSE;
      bridge->transition_in_progress = FALSE;
      g_clear_pointer (&bridge->transition_commit, g_free);
      return_void (invocation);
    }
  else if (g_str_equal (method_name, "ResetSync"))
    {
      begin_transition (bridge);
      nimf_im_reset (bridge->im);
      bridge->preedit_visible = FALSE;
      return_transition_commit (bridge, invocation);
    }
  else if (g_str_equal (method_name, "SetCursorLocation"))
    {
      NimfLegacyRectangle rect;

      g_variant_get (parameters,
                     "(iiii)",
                     &rect.x,
                     &rect.y,
                     &rect.width,
                     &rect.height);
      nimf_im_set_cursor_location (bridge->im, &rect);
      return_void (invocation);
    }
  else if (g_str_equal (method_name, "SetSurrounding"))
    {
      const gchar *text;
      guint cursor;
      guint anchor;
      gsize length;

      g_variant_get (parameters, "(&suu)", &text, &cursor, &anchor);
      (void) anchor;

      if (!g_utf8_validate (text, -1, NULL))
        {
          g_dbus_method_invocation_return_error_literal (
            invocation,
            G_IO_ERROR,
            G_IO_ERROR_INVALID_DATA,
            "Surrounding text is not valid UTF-8");
          return;
        }

      length = strlen (text);
      if (length > G_MAXINT)
        {
          g_dbus_method_invocation_return_error_literal (
            invocation,
            G_IO_ERROR,
            G_IO_ERROR_NO_SPACE,
            "Surrounding text is too large");
          return;
        }

      g_free (bridge->surrounding_text);
      bridge->surrounding_text = g_strdup (text);
      bridge->surrounding_cursor =
        byte_cursor_to_character_cursor (text, cursor);

      nimf_im_set_surrounding (bridge->im,
                               text,
                               (gint) length,
                               bridge->surrounding_cursor);
      return_void (invocation);
    }
  else if (g_str_equal (method_name, "SetUsePreedit"))
    {
      gboolean enabled;

      g_variant_get (parameters, "(b)", &enabled);
      nimf_im_set_use_preedit (bridge->im, enabled);
      return_void (invocation);
    }
  else if (g_str_equal (method_name, "FilterKeyEvent"))
    {
      NimfLegacyEvent event = { 0 };
      guint keyval;
      guint keycode;
      guint state;
      guint focus_generation;
      gboolean press;
      gboolean handled;

      g_variant_get (parameters,
                     "(uuuub)",
                     &keyval,
                     &keycode,
                     &state,
                     &focus_generation,
                     &press);
      bridge->focus_generation = focus_generation;
      event.type = press ? NIMF_LEGACY_EVENT_KEY_PRESS
                         : NIMF_LEGACY_EVENT_KEY_RELEASE;
      event.state = state & NIMF_MODIFIER_MASK;
      event.keyval = keyval;
      event.hardware_keycode = keycode;
      bridge->filtering_key_event = TRUE;
      handled = nimf_im_filter_event (bridge->im, &event);
      bridge->filtering_key_event = FALSE;
      g_dbus_method_invocation_return_value (invocation,
                                             g_variant_new ("(b)", handled));
    }
  else
    {
      g_dbus_method_invocation_return_error (
        invocation,
        G_DBUS_ERROR,
        G_DBUS_ERROR_UNKNOWN_METHOD,
        "Unknown method: %s",
        method_name);
    }
}

static const GDBusInterfaceVTable interface_vtable =
{
  .method_call = handle_method_call,
  .get_property = NULL,
  .set_property = NULL,
};

static void
on_bus_acquired (GDBusConnection *connection,
                 const gchar *name,
                 gpointer user_data)
{
  Bridge *bridge = user_data;
  g_autoptr (GError) error = NULL;

  (void) name;
  bridge->connection = g_object_ref (connection);
  bridge->registration_id =
    g_dbus_connection_register_object (connection,
                                       OBJECT_PATH,
                                       bridge->introspection->interfaces[0],
                                       &interface_vtable,
                                       bridge,
                                       NULL,
                                       &error);
  if (!bridge->registration_id)
    {
      g_critical ("Could not register D-Bus object: %s", error->message);
      bridge->exit_status = EXIT_FAILURE;
      g_main_loop_quit (bridge->loop);
      return;
    }

  g_message ("Nimf Shell bridge is ready on %s", BUS_NAME);
}

static void
on_name_lost (GDBusConnection *connection,
              const gchar *name,
              gpointer user_data)
{
  Bridge *bridge = user_data;

  (void) connection;
  g_warning ("Could not own D-Bus name %s", name);
  bridge->exit_status = EXIT_FAILURE;
  g_main_loop_quit (bridge->loop);
}

static gboolean
quit_signal_cb (gpointer user_data)
{
  Bridge *bridge = user_data;
  g_main_loop_quit (bridge->loop);
  return G_SOURCE_REMOVE;
}

static void
install_callbacks (Bridge *bridge)
{
  nimf_im_set_callback (bridge->im,
                        NIMF_LEGACY_CALLBACK_PREEDIT_START,
                        on_preedit_start,
                        bridge);
  nimf_im_set_callback (bridge->im,
                        NIMF_LEGACY_CALLBACK_PREEDIT_END,
                        on_preedit_end,
                        bridge);
  nimf_im_set_callback (bridge->im,
                        NIMF_LEGACY_CALLBACK_PREEDIT_CHANGED,
                        on_preedit_changed,
                        bridge);
  nimf_im_set_callback (bridge->im,
                        NIMF_LEGACY_CALLBACK_COMMIT,
                        on_commit,
                        bridge);
  nimf_im_set_callback (bridge->im,
                        NIMF_LEGACY_CALLBACK_RETRIEVE_SURROUNDING,
                        on_retrieve_surrounding,
                        bridge);
  nimf_im_set_callback (bridge->im,
                        NIMF_LEGACY_CALLBACK_DELETE_SURROUNDING,
                        on_delete_surrounding,
                        bridge);
  nimf_im_set_callback (bridge->im,
                        NIMF_LEGACY_CALLBACK_BEEP,
                        on_beep,
                        bridge);
}

int
main (int argc, char **argv)
{
  Bridge bridge = { 0 };
  g_autoptr (GError) error = NULL;

  if (argc > 1 && g_str_equal (argv[1], "--check"))
    {
      NimfIM *im = nimf_im_new ();

      if (!im)
        {
          g_printerr ("Could not create a legacy Nimf input context\n");
          return EXIT_FAILURE;
        }

      nimf_im_free (im);
      g_print ("legacy Nimf ABI check: OK\n");
      return EXIT_SUCCESS;
    }

  bridge.loop = g_main_loop_new (NULL, FALSE);
  bridge.introspection = g_dbus_node_info_new_for_xml (introspection_xml,
                                                       &error);
  if (!bridge.introspection)
    {
      g_printerr ("Invalid D-Bus introspection XML: %s\n", error->message);
      return EXIT_FAILURE;
    }

  bridge.im = nimf_im_new ();
  if (!bridge.im)
    {
      g_printerr ("Could not create a legacy Nimf input context\n");
      g_dbus_node_info_unref (bridge.introspection);
      g_main_loop_unref (bridge.loop);
      return EXIT_FAILURE;
    }

  install_callbacks (&bridge);
  bridge.owner_id = g_bus_own_name (G_BUS_TYPE_SESSION,
                                    BUS_NAME,
                                    G_BUS_NAME_OWNER_FLAGS_NONE,
                                    on_bus_acquired,
                                    NULL,
                                    on_name_lost,
                                    &bridge,
                                    NULL);
  g_unix_signal_add (SIGINT, quit_signal_cb, &bridge);
  g_unix_signal_add (SIGTERM, quit_signal_cb, &bridge);
  g_main_loop_run (bridge.loop);

  if (bridge.focused)
    nimf_im_focus_out (bridge.im);
  if (bridge.registration_id && bridge.connection)
    g_dbus_connection_unregister_object (bridge.connection,
                                         bridge.registration_id);
  if (bridge.owner_id)
    g_bus_unown_name (bridge.owner_id);
  g_clear_object (&bridge.connection);
  discard_deferred_commit (&bridge);
  nimf_im_free (bridge.im);
  g_free (bridge.surrounding_text);
  g_free (bridge.transition_commit);
  g_dbus_node_info_unref (bridge.introspection);
  g_main_loop_unref (bridge.loop);

  return bridge.exit_status;
}
