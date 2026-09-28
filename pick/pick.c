/* pick: a minimal screen color picker for GNOME Wayland.
 *
 * Freezes the screen through the XDG screenshot portal, shows it full screen
 * on every monitor with a magnifier under the pointer, and copies the color
 * you click. The frozen frame means nothing moves while you aim.
 *
 *   click           copy #rrggbb
 *   shift+click     copy rgb(r, g, b)
 *   ctrl+click      copy hsl(h, s%, l%)
 *   arrows          nudge one pixel (shift: ten)
 *   scroll, +/-     zoom the magnifier
 *   esc, right      cancel
 *
 * Build: make    Run: pick
 */
#include <gtk/gtk.h>
#include <math.h>

#define APP_ID      "com.ahmadcodes.Pick"
#define LOUPE_CELLS 15            /* odd: center cell is the picked pixel */
#define LINGER_SECS (30 * 60)     /* keep serving the clipboard at most this long */

typedef enum { FMT_HEX, FMT_RGB, FMT_HSL } Format;

typedef struct {
  GtkApplication *app;
  GdkTexture *shot;
  guchar *pixels;               /* BGRA premultiplied (opaque), little endian */
  gsize stride;
  int sw, sh;                   /* screenshot size in pixels */
  double scale_x, scale_y;      /* screenshot pixels per logical pixel */
  int origin_x, origin_y;       /* logical position of the layout's top-left */
  GPtrArray *views;
  GtkWidget *active;            /* view the pointer is over */
  double px, py;                /* pointer, widget coordinates of active view */
  int nudge_x, nudge_y;
  int zoom;
  gboolean busy;
  guint portal_sub;
  guint linger_id;
  gulong clipboard_handler;
} Pick;

static Pick P = { .zoom = 10 };

/* ------------------------------------------------------------------ view */

#define PICK_TYPE_VIEW (pick_view_get_type ())
G_DECLARE_FINAL_TYPE (PickView, pick_view, PICK, VIEW, GtkWidget)

struct _PickView {
  GtkWidget parent;
  GdkRectangle geo;             /* monitor geometry, logical */
};

G_DEFINE_TYPE (PickView, pick_view, GTK_TYPE_WIDGET)

static gboolean
sample (int *cx, int *cy, guint8 *r, guint8 *g, guint8 *b)
{
  if (!P.active)
    return FALSE;
  PickView *v = PICK_VIEW (P.active);
  int x = (int) floor ((v->geo.x - P.origin_x + P.px) * P.scale_x) + P.nudge_x;
  int y = (int) floor ((v->geo.y - P.origin_y + P.py) * P.scale_y) + P.nudge_y;
  x = CLAMP (x, 0, P.sw - 1);
  y = CLAMP (y, 0, P.sh - 1);
  const guint8 *p = P.pixels + (gsize) y * P.stride + (gsize) x * 4;
  *cx = x; *cy = y;
  *b = p[0]; *g = p[1]; *r = p[2];
  return TRUE;
}

static void
format_color (Format fmt, guint8 r, guint8 g, guint8 b, char *out, gsize len)
{
  if (fmt == FMT_RGB) {
    g_snprintf (out, len, "rgb(%u, %u, %u)", r, g, b);
    return;
  }
  if (fmt == FMT_HSL) {
    double R = r / 255.0, G = g / 255.0, B = b / 255.0;
    double mx = MAX (R, MAX (G, B)), mn = MIN (R, MIN (G, B));
    double l = (mx + mn) / 2, h = 0, s = 0, d = mx - mn;
    if (d > 0) {
      s = d / (1 - fabs (2 * l - 1));
      if (mx == R)      h = fmod ((G - B) / d, 6);
      else if (mx == G) h = (B - R) / d + 2;
      else              h = (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    g_snprintf (out, len, "hsl(%.0f, %.0f%%, %.0f%%)", h, s * 100, l * 100);
    return;
  }
  g_snprintf (out, len, "#%02x%02x%02x", r, g, b);
}

static void
rounded (GskRoundedRect *rr, float x, float y, float w, float h, float radius)
{
  gsk_rounded_rect_init_from_rect (rr, &GRAPHENE_RECT_INIT (x, y, w, h), radius);
}

static void
pick_view_snapshot (GtkWidget *widget, GtkSnapshot *s)
{
  PickView *v = PICK_VIEW (widget);
  float W = gtk_widget_get_width (widget), H = gtk_widget_get_height (widget);

  /* the frozen screen, this monitor's slice of it */
  gtk_snapshot_push_clip (s, &GRAPHENE_RECT_INIT (0, 0, W, H));
  gtk_snapshot_append_scaled_texture (s, P.shot, GSK_SCALING_FILTER_NEAREST,
      &GRAPHENE_RECT_INIT (P.origin_x - v->geo.x, P.origin_y - v->geo.y,
                           P.sw / P.scale_x, P.sh / P.scale_y));
  gtk_snapshot_pop (s);

  if (P.active != widget)
    return;

  int cx, cy; guint8 r, g, b;
  if (!sample (&cx, &cy, &r, &g, &b))
    return;

  /* magnifier: LOUPE_CELLS x LOUPE_CELLS source pixels, zoomed */
  float z = P.zoom, size = LOUPE_CELLS * z, half = (LOUPE_CELLS / 2) * z;
  float lx = P.px + 28, ly = P.py + 28;
  if (lx + size > W - 8) lx = P.px - 28 - size;
  if (ly + size + 58 > H - 8) ly = P.py - 28 - size - 58;

  GskRoundedRect rr;
  rounded (&rr, lx, ly, size, size, size / 2);
  gtk_snapshot_append_outset_shadow (s, &rr, &(GdkRGBA){ 0, 0, 0, 0.45 }, 0, 6, 0, 18);
  gtk_snapshot_push_rounded_clip (s, &rr);
  gtk_snapshot_append_scaled_texture (s, P.shot, GSK_SCALING_FILTER_NEAREST,
      &GRAPHENE_RECT_INIT (lx + half - cx * z, ly + half - cy * z, P.sw * z, P.sh * z));
  /* center cell outline: dark then light so it shows on any color */
  gtk_snapshot_append_border (s,
      &(GskRoundedRect){ .bounds = GRAPHENE_RECT_INIT (lx + half - 1, ly + half - 1, z + 2, z + 2) },
      (float[4]){ 1, 1, 1, 1 }, (GdkRGBA[4]){ [0 ... 3] = { 0, 0, 0, 0.9 } });
  gtk_snapshot_append_border (s,
      &(GskRoundedRect){ .bounds = GRAPHENE_RECT_INIT (lx + half, ly + half, z, z) },
      (float[4]){ 1, 1, 1, 1 }, (GdkRGBA[4]){ [0 ... 3] = { 1, 1, 1, 0.95 } });
  gtk_snapshot_pop (s);
  /* ring in the picked color, with a white rim */
  GdkRGBA col = { r / 255.f, g / 255.f, b / 255.f, 1 };
  gtk_snapshot_append_border (s, &rr, (float[4]){ 6, 6, 6, 6 }, (GdkRGBA[4]){ col, col, col, col });
  gtk_snapshot_append_border (s, &rr, (float[4]){ 1.5, 1.5, 1.5, 1.5 },
      (GdkRGBA[4]){ [0 ... 3] = { 1, 1, 1, 0.9 } });

  /* label: swatch + hex, rgb underneath */
  char hex[16], rgb[32], text[64];
  format_color (FMT_HEX, r, g, b, hex, sizeof hex);
  format_color (FMT_RGB, r, g, b, rgb, sizeof rgb);
  g_snprintf (text, sizeof text, "%s\n<span alpha='60%%' size='small'>%s</span>", hex, rgb);

  PangoLayout *layout = gtk_widget_create_pango_layout (widget, NULL);
  PangoFontDescription *font = pango_font_description_from_string ("Monospace Bold 11");
  pango_layout_set_font_description (layout, font);
  pango_layout_set_markup (layout, text, -1);
  int tw, th;
  pango_layout_get_pixel_size (layout, &tw, &th);

  float bw = 12 + 22 + 10 + tw + 14, bh = th + 16;
  float bx = lx + (size - bw) / 2, by = ly + size + 10;
  rounded (&rr, bx, by, bw, bh, 10);
  gtk_snapshot_append_outset_shadow (s, &rr, &(GdkRGBA){ 0, 0, 0, 0.4 }, 0, 4, 0, 12);
  gtk_snapshot_push_rounded_clip (s, &rr);
  gtk_snapshot_append_color (s, &(GdkRGBA){ 0.11, 0.11, 0.13, 0.94 }, &rr.bounds);
  gtk_snapshot_pop (s);
  rounded (&rr, bx + 12, by + (bh - 22) / 2, 22, 22, 6);
  gtk_snapshot_push_rounded_clip (s, &rr);
  gtk_snapshot_append_color (s, &col, &rr.bounds);
  gtk_snapshot_pop (s);
  gtk_snapshot_append_border (s, &rr, (float[4]){ 1, 1, 1, 1 },
      (GdkRGBA[4]){ [0 ... 3] = { 1, 1, 1, 0.35 } });

  gtk_snapshot_save (s);
  gtk_snapshot_translate (s, &GRAPHENE_POINT_INIT (bx + 12 + 22 + 10, by + 8));
  gtk_snapshot_append_layout (s, layout, &(GdkRGBA){ 1, 1, 1, 1 });
  gtk_snapshot_restore (s);

  pango_font_description_free (font);
  g_object_unref (layout);
}

static void pick_view_class_init (PickViewClass *k) { GTK_WIDGET_CLASS (k)->snapshot = pick_view_snapshot; }
static void pick_view_init (PickView *v) { gtk_widget_set_cursor_from_name (GTK_WIDGET (v), "crosshair"); }

/* ------------------------------------------------------------ lifecycle */

static void
redraw_all (void)
{
  for (guint i = 0; P.views && i < P.views->len; i++)
    gtk_widget_queue_draw (g_ptr_array_index (P.views, i));
}

static void
end_session (void)
{
  if (P.views) {
    for (guint i = 0; i < P.views->len; i++)
      gtk_window_destroy (GTK_WINDOW (gtk_widget_get_root (g_ptr_array_index (P.views, i))));
    g_clear_pointer (&P.views, g_ptr_array_unref);
  }
  P.active = NULL;
  g_clear_pointer (&P.pixels, g_free);
  g_clear_object (&P.shot);
  P.busy = FALSE;
}

static gboolean
stop_lingering (gpointer data)
{
  (void) data;
  GdkClipboard *cb = gdk_display_get_clipboard (gdk_display_get_default ());
  if (P.clipboard_handler)
    g_signal_handler_disconnect (cb, P.clipboard_handler);
  P.clipboard_handler = 0;
  if (P.linger_id)
    g_source_remove (P.linger_id);
  P.linger_id = 0;
  g_application_release (G_APPLICATION (P.app));
  return G_SOURCE_REMOVE;
}

static void
on_clipboard_changed (GdkClipboard *cb, gpointer data)
{
  (void) data;
  /* someone else copied: our value is no longer needed */
  if (!gdk_clipboard_is_local (cb))
    stop_lingering (NULL);
}

static gboolean
withdraw_notification (gpointer data)
{
  (void) data;
  g_application_withdraw_notification (G_APPLICATION (P.app), "picked");
  return G_SOURCE_REMOVE;
}

static void
copy_and_quit (Format fmt)
{
  int cx, cy; guint8 r, g, b;
  if (!sample (&cx, &cy, &r, &g, &b))
    return;
  char out[40];
  format_color (fmt, r, g, b, out, sizeof out);

  GdkClipboard *cb = gdk_display_get_clipboard (gdk_display_get_default ());
  gdk_clipboard_set_text (cb, out);
  g_print ("%s\n", out);

  /* On Wayland the clipboard is served by its owner, so stay alive
   * (windowless) until something else is copied. */
  if (!P.linger_id) {
    g_application_hold (G_APPLICATION (P.app));
    P.clipboard_handler = g_signal_connect (cb, "changed", G_CALLBACK (on_clipboard_changed), NULL);
  } else {
    g_source_remove (P.linger_id);
  }
  P.linger_id = g_timeout_add_seconds (LINGER_SECS, stop_lingering, NULL);

  /* brief confirmation, withdrawn so it does not pile up in the tray */
  GNotification *n = g_notification_new ("Color copied");
  g_notification_set_body (n, out);
  g_application_send_notification (G_APPLICATION (P.app), "picked", n);
  g_object_unref (n);
  g_timeout_add_seconds (3, withdraw_notification, NULL);

  end_session ();
}

/* --------------------------------------------------------------- input */

static void
on_motion (GtkEventControllerMotion *c, double x, double y, gpointer data)
{
  (void) data;
  GtkWidget *w = gtk_event_controller_get_widget (GTK_EVENT_CONTROLLER (c));
  if (P.active != w)
    redraw_all ();
  if (P.active == w && (fabs (x - P.px) >= 1 || fabs (y - P.py) >= 1))
    P.nudge_x = P.nudge_y = 0;   /* real mouse movement resets keyboard nudging */
  P.active = w;
  P.px = x; P.py = y;
  gtk_widget_queue_draw (w);
}

static Format
format_for_state (GdkModifierType state)
{
  if (state & GDK_SHIFT_MASK)   return FMT_RGB;
  if (state & GDK_CONTROL_MASK) return FMT_HSL;
  return FMT_HEX;
}

static void
on_click (GtkGestureClick *g, int n, double x, double y, gpointer data)
{
  (void) n; (void) data;
  GtkEventController *c = GTK_EVENT_CONTROLLER (g);
  if (gtk_gesture_single_get_current_button (GTK_GESTURE_SINGLE (g)) != GDK_BUTTON_PRIMARY) {
    end_session ();
    return;
  }
  P.active = gtk_event_controller_get_widget (c);
  P.px = x; P.py = y;
  copy_and_quit (format_for_state (gtk_event_controller_get_current_event_state (c)));
}

static void
set_zoom (int z)
{
  P.zoom = CLAMP (z, 4, 24);
  redraw_all ();
}

static gboolean
on_scroll (GtkEventControllerScroll *c, double dx, double dy, gpointer data)
{
  (void) c; (void) dx; (void) data;
  set_zoom (P.zoom + (dy < 0 ? 2 : -2));
  return TRUE;
}

static gboolean
on_key (GtkEventControllerKey *c, guint key, guint code, GdkModifierType state, gpointer data)
{
  (void) c; (void) code; (void) data;
  int step = (state & GDK_SHIFT_MASK) ? 10 : 1;
  switch (key) {
  case GDK_KEY_Escape:   end_session (); return TRUE;
  case GDK_KEY_Return:
  case GDK_KEY_KP_Enter:
  case GDK_KEY_space:    copy_and_quit (format_for_state (state)); return TRUE;
  case GDK_KEY_Left:     P.nudge_x -= step; break;
  case GDK_KEY_Right:    P.nudge_x += step; break;
  case GDK_KEY_Up:       P.nudge_y -= step; break;
  case GDK_KEY_Down:     P.nudge_y += step; break;
  case GDK_KEY_plus:
  case GDK_KEY_equal:
  case GDK_KEY_KP_Add:   set_zoom (P.zoom + 2); return TRUE;
  case GDK_KEY_minus:
  case GDK_KEY_KP_Subtract: set_zoom (P.zoom - 2); return TRUE;
  case GDK_KEY_r:        copy_and_quit (FMT_RGB); return TRUE;
  case GDK_KEY_h:        copy_and_quit (FMT_HSL); return TRUE;
  default:               return FALSE;
  }
  redraw_all ();
  return TRUE;
}

/* ------------------------------------------------------------ overlay */

static void
show_overlay (void)
{
  GdkDisplay *display = gdk_display_get_default ();
  GListModel *monitors = gdk_display_get_monitors (display);
  guint n = g_list_model_get_n_items (monitors);
  int x0 = G_MAXINT, y0 = G_MAXINT, x1 = G_MININT, y1 = G_MININT;

  for (guint i = 0; i < n; i++) {
    GdkMonitor *m = g_list_model_get_item (monitors, i);
    GdkRectangle r;
    gdk_monitor_get_geometry (m, &r);
    x0 = MIN (x0, r.x); y0 = MIN (y0, r.y);
    x1 = MAX (x1, r.x + r.width); y1 = MAX (y1, r.y + r.height);
    g_object_unref (m);
  }
  P.origin_x = x0; P.origin_y = y0;
  P.scale_x = (double) P.sw / (x1 - x0);
  P.scale_y = (double) P.sh / (y1 - y0);

  P.views = g_ptr_array_new ();
  for (guint i = 0; i < n; i++) {
    GdkMonitor *m = g_list_model_get_item (monitors, i);
    PickView *v = g_object_new (PICK_TYPE_VIEW, NULL);
    gdk_monitor_get_geometry (m, &v->geo);

    GtkWidget *win = gtk_application_window_new (P.app);
    gtk_window_set_decorated (GTK_WINDOW (win), FALSE);
    gtk_window_set_title (GTK_WINDOW (win), "Pick a color");
    gtk_window_set_child (GTK_WINDOW (win), GTK_WIDGET (v));

    GtkEventController *motion = gtk_event_controller_motion_new ();
    g_signal_connect (motion, "motion", G_CALLBACK (on_motion), NULL);
    g_signal_connect (motion, "enter", G_CALLBACK (on_motion), NULL);
    gtk_widget_add_controller (GTK_WIDGET (v), motion);

    GtkGesture *click = gtk_gesture_click_new ();
    gtk_gesture_single_set_button (GTK_GESTURE_SINGLE (click), 0);
    g_signal_connect (click, "pressed", G_CALLBACK (on_click), NULL);
    gtk_widget_add_controller (GTK_WIDGET (v), GTK_EVENT_CONTROLLER (click));

    GtkEventController *scroll = gtk_event_controller_scroll_new (GTK_EVENT_CONTROLLER_SCROLL_VERTICAL);
    g_signal_connect (scroll, "scroll", G_CALLBACK (on_scroll), NULL);
    gtk_widget_add_controller (GTK_WIDGET (v), scroll);

    GtkEventController *keys = gtk_event_controller_key_new ();
    g_signal_connect (keys, "key-pressed", G_CALLBACK (on_key), NULL);
    gtk_widget_add_controller (win, keys);

    g_ptr_array_add (P.views, v);
    gtk_window_fullscreen_on_monitor (GTK_WINDOW (win), m);
    gtk_window_present (GTK_WINDOW (win));
    g_object_unref (m);
  }
}

/* ------------------------------------------------------- screenshot portal */

static void
on_portal_response (GDBusConnection *bus, const char *sender, const char *path,
                    const char *iface, const char *signal, GVariant *params, gpointer data)
{
  (void) sender; (void) path; (void) iface; (void) signal; (void) data;
  g_dbus_connection_signal_unsubscribe (bus, P.portal_sub);
  P.portal_sub = 0;

  guint32 response;
  g_autoptr (GVariant) results = NULL;
  g_variant_get (params, "(u@a{sv})", &response, &results);
  const char *uri = NULL;
  g_variant_lookup (results, "uri", "&s", &uri);

  if (response != 0 || !uri) {
    g_printerr ("pick: screenshot was cancelled or refused\n");
    P.busy = FALSE;
    g_application_release (G_APPLICATION (P.app));
    return;
  }

  g_autoptr (GFile) file = g_file_new_for_uri (uri);
  g_autoptr (GError) err = NULL;
  P.shot = gdk_texture_new_from_file (file, &err);
  g_file_delete (file, NULL, NULL);    /* the portal's copy is ours to clean up */
  if (!P.shot) {
    g_printerr ("pick: %s\n", err->message);
    P.busy = FALSE;
    g_application_release (G_APPLICATION (P.app));
    return;
  }

  P.sw = gdk_texture_get_width (P.shot);
  P.sh = gdk_texture_get_height (P.shot);
  GdkTextureDownloader *dl = gdk_texture_downloader_new (P.shot);
  gdk_texture_downloader_set_format (dl, GDK_MEMORY_B8G8R8A8_PREMULTIPLIED);
  P.stride = (gsize) P.sw * 4;
  P.pixels = g_malloc ((gsize) P.sh * P.stride);
  gdk_texture_downloader_download_into (dl, P.pixels, P.stride);
  gdk_texture_downloader_free (dl);

  P.nudge_x = P.nudge_y = 0;
  show_overlay ();
  g_application_release (G_APPLICATION (P.app));
}

static void
request_screenshot (void)
{
  g_autoptr (GError) err = NULL;
  GDBusConnection *bus = g_application_get_dbus_connection (G_APPLICATION (P.app));
  if (!bus) {
    g_printerr ("pick: no session bus\n");
    return;
  }
  g_autofree char *sender = g_strdup (g_dbus_connection_get_unique_name (bus) + 1);
  g_strdelimit (sender, ".", '_');
  g_autofree char *token = g_strdup_printf ("pick%u", g_random_int ());
  g_autofree char *handle = g_strdup_printf ("/org/freedesktop/portal/desktop/request/%s/%s", sender, token);

  /* subscribe before calling, so a fast response cannot be missed */
  P.portal_sub = g_dbus_connection_signal_subscribe (bus, "org.freedesktop.portal.Desktop",
      "org.freedesktop.portal.Request", "Response", handle, NULL,
      G_DBUS_SIGNAL_FLAGS_NONE, on_portal_response, NULL, NULL);

  GVariantBuilder opts;
  g_variant_builder_init (&opts, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add (&opts, "{sv}", "handle_token", g_variant_new_string (token));
  g_variant_builder_add (&opts, "{sv}", "interactive", g_variant_new_boolean (FALSE));

  g_application_hold (G_APPLICATION (P.app));
  g_autoptr (GVariant) ret = g_dbus_connection_call_sync (bus, "org.freedesktop.portal.Desktop",
      "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot", "Screenshot",
      g_variant_new ("(sa{sv})", "", &opts), G_VARIANT_TYPE ("(o)"),
      G_DBUS_CALL_FLAGS_NONE, 5000, NULL, &err);
  if (!ret) {
    g_printerr ("pick: screenshot portal: %s\n", err->message);
    g_dbus_connection_signal_unsubscribe (bus, P.portal_sub);
    P.portal_sub = 0;
    P.busy = FALSE;
    g_application_release (G_APPLICATION (P.app));
  }
}

static void
on_activate (GApplication *app, gpointer data)
{
  (void) app; (void) data;
  if (P.busy)
    return;
  P.busy = TRUE;
  request_screenshot ();
}

int
main (int argc, char **argv)
{
  P.app = gtk_application_new (APP_ID, G_APPLICATION_DEFAULT_FLAGS);
  g_signal_connect (P.app, "activate", G_CALLBACK (on_activate), NULL);
  int status = g_application_run (G_APPLICATION (P.app), argc, argv);
  g_object_unref (P.app);
  return status;
}
