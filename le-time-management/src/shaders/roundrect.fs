#version 330

in vec2 fragTexCoord;
in vec4 fragColor;

uniform sampler2D texture0;
uniform vec2 size;
uniform float roundness;
uniform float feather;
uniform vec2 uvMin;
uniform vec2 uvMax;
uniform vec2 destMin;
uniform vec2 destMax;
uniform vec2 resolution;

out vec4 finalColor;

void main()
{
    // SDF in real screen pixel space. Fragment shaders cannot reliably use
    // gl_Position, so convert gl_FragCoord from OpenGL bottom-left origin to
    // the UI top-left origin used by raylib drawing coordinates.
    vec2 pixelPos = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);
    vec2 p = pixelPos - destMin;

    float radius = clamp(roundness, 0.0, 1.0) * 0.5 * min(size.x, size.y);
    vec2 b = size * 0.5 - vec2(radius);
    vec2 q = abs(p - size * 0.5) - b;
    float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;

    float fw = max(feather, 0.5);
    float alphaMask = 1.0 - smoothstep(-fw, 0.0, d);

    vec4 texColor = texture(texture0, fragTexCoord) * fragColor;
    finalColor = vec4(texColor.rgb, texColor.a * alphaMask);
}
