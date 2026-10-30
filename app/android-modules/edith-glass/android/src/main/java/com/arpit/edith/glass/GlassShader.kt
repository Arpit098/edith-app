package com.arpit.edith.glass

/**
 * The Liquid Glass lens, in AGSL (Android 13+, RuntimeShader). Our own code, not adapted from
 * another project.
 *
 * `content` is the backdrop, already blurred (the blur effect runs first in the chain). For each
 * pixel of the rounded rectangle:
 * - refraction: near the rim the backdrop is sampled from further inside, along the shape's normal
 *   (the signed-distance gradient), so it bends like a thick lens edge; the interior is unchanged;
 * - dispersion: red and blue are sampled a little further and a little nearer than green there, a
 *   thin coloured fringe at the rim;
 * - saturation lifted inside, then the glass tint laid over;
 * - a specular highlight along the rim facing the light (top-left);
 * - an antialiased edge; outside the shape it's transparent.
 */
internal const val GLASS_AGSL = """
uniform shader content;
uniform float2 origin;     // the glass rectangle's top-left in the node (the capture has a margin)
uniform float2 size;
uniform float radius;
uniform float bezel;       // width of the refracting rim, px
uniform float refraction;  // displacement at the very edge, px
uniform float dispersion;  // 0..1: how far apart red and blue are sampled at the rim
uniform float saturation;  // 1 = unchanged
uniform half4 tint;        // straight (not premultiplied) colour; alpha = how much
uniform float specular;    // highlight strength, 0..1

float roundRect(float2 p, float2 b, float r) {
  float2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
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
  float k = rim * rim * rim;                      // a lens profile: steep only near the edge
  float2 off = -n * refraction * k;               // look inward: the edge magnifies what's inside

  half4 col = content.eval(coord + off);
  if (dispersion > 0.0) {
    col.r = content.eval(coord + off * (1.0 + dispersion)).r;
    col.b = content.eval(coord + off * (1.0 - dispersion)).b;
  }
  // Colours are premultiplied. Saturation works on the straight colour; where the backdrop is
  // transparent (what's behind it isn't in the capture) the glass stays as see-through as its tint.
  half a = col.a;
  half3 rgb = a > 0.0 ? col.rgb / a : half3(0.0);
  half l = dot(rgb, half3(0.2126, 0.7152, 0.0722));
  rgb = mix(half3(l), rgb, half(saturation)) * a;
  rgb = tint.rgb * tint.a + rgb * (1.0 - tint.a);
  a = tint.a + a * (1.0 - tint.a);

  float lit = clamp(dot(n, float2(-0.6, -0.8)), 0.0, 1.0);
  half s = half(specular * lit * lit * lit * rim * rim);
  rgb += half3(s);
  a = min(a + s, 1.0);

  half aa = half(clamp(0.5 - d, 0.0, 1.0));
  return half4(rgb, a) * aa;
}
"""
