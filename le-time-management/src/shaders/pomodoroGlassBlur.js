// Adapted from the local refraction lab's neverlose_title_blur.fs for the timer card.
export const BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 fragTexCoord;
out vec4 finalColor;
uniform sampler2D texture0;
uniform vec2 resolution;
uniform float blurRadius;

void main() {
  vec2 stepPx = vec2(1.0) / resolution;
  vec3 color = vec3(0.0);
  float total = 0.0;
  for (int row = -6; row <= 6; ++row) {
    for (int column = -6; column <= 6; ++column) {
      vec2 offset = vec2(float(column), float(row));
      float weight = exp(-dot(offset, offset) / 18.0);
      vec2 uv = clamp(fragTexCoord + offset * stepPx * blurRadius / 6.0, vec2(0.0), vec2(1.0));
      color += texture(texture0, uv).rgb * weight;
      total += weight;
    }
  }
  finalColor = vec4(color / total, 1.0);
}`;
