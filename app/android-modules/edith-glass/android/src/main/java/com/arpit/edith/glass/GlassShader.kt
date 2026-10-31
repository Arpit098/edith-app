package com.arpit.edith.glass

/**
 * The Liquid Glass lens, in AGSL (Android 13+, RuntimeShader). Our own code, not adapted from
 * another project.
 *
 * `content` is the backdrop, already blurred (the blur effect runs first in the chain). It can be
 * transparent between things (a list over the app's background, which is drawn elsewhere), so each
 * sample is laid over `base`, the app's background colour: the glass is opaque inside its shape and
 * the real content behind it never shows through sharp. For each pixel of the rounded rectangle:
 * - refraction: towards the rim the backdrop is sampled from further inside, along the shape's
 *   normal (the signed-distance gradient), growing towards the edge like a thick lens;
 * - dispersion: red and blue are sampled `dispersion` px either side of green along the normal, a
 *   thin colour fringe that only appears at the rim;
 * - frost: saturation lifted (colours glow through the blur), a small luminance lift, the tint;
 * - a thin specular line along the edge, brightest on the top;
 * - an antialiased edge; outside the shape it's transparent.
 */
internal const val GLASS_AGSL = """
uniform shader content;
uniform float2 origin;     // the glass rectangle's top-left in the node (the capture has a margin)
uniform float2 size;
uniform float radius;
uniform float bezel;       // width of the refracting rim, px
uniform float refraction;  // displacement at the very edge, px
uniform float dispersion;  // red/blue split at the edge, px
uniform float saturation;  // 1 = unchanged
uniform float lift;        // added to every channel: the frost's slight glow
uniform half4 tint;        // straight (not premultiplied) colour; alpha = how much
uniform half4 base;        // opaque colour under the backdrop (the app's background)
uniform float specular;    // highlight strength, 0..1
uniform float rimWidth;    // how far in from the edge the highlight reaches, px

float roundRect(float2 p, float2 b, float r) {
  float2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

half3 over(half4 c) {      // a premultiplied sample laid over the base colour
  return c.rgb + base.rgb * (1.0 - c.a);
}

half4 main(float2 coord) {
  float2 hs = size * 0.5;
  float2 c = coord - origin - hs;
  float d = roundRect(c, hs, radius);
  if (d > 1.0) return half4(0.0);

  float2 g = float2(
    roundRect(c + float2(1.0, 0.0), hs, radius) - roundRect(c - float2(1.0, 0.0), hs, radius),
    roundRect(c + float2(0.0, 1.0), hs, radius) - roundRect(c - float2(0.0, 1.0), hs, radius));
  float2 n = g / max(length(g), 0.0001);          // outward normal
  float rim = clamp(1.0 + d / bezel, 0.0, 1.0);   // 0 inside the bezel, 1 at the edge
  float k = rim * rim;                            // grows towards the edge
  float2 off = -n * refraction * k;               // look inward: the edge magnifies what's inside
  float2 split = n * dispersion * k;

  half3 rgb = half3(
    over(content.eval(coord + off + split)).r,
    over(content.eval(coord + off)).g,
    over(content.eval(coord + off - split)).b);

  half l = dot(rgb, half3(0.2126, 0.7152, 0.0722));
  rgb = mix(half3(l), rgb, half(saturation)) + half(lift);
  rgb = mix(rgb, tint.rgb, tint.a);

  float edge = clamp(1.0 + d / rimWidth, 0.0, 1.0); // 1 at the edge, 0 rimWidth inside
  float up = clamp(-n.y, 0.0, 1.0);                 // the top edge catches the light
  rgb += half(specular * edge * edge * (0.3 + 0.7 * up));

  half aa = half(clamp(0.5 - d, 0.0, 1.0));
  return half4(clamp(rgb, 0.0, 1.0) * aa, aa);
}
"""
