#version 100
precision mediump float;

varying vec2 fragTexCoord;

uniform sampler2D texture0;
uniform vec2 resolution;

// 玻璃区域（像素坐标）：x,y,w,h
uniform vec4 rectPx;

// 圆角半径（像素）
uniform float cornerRadiusPx;

// 玻璃厚度（像素，越大边缘越"立体"）
uniform float thicknessPx;

// 折射强度（像素级）
uniform float distortionPx;

// 玻璃边缘高光强度（可调，效果明显）
uniform float highlightStrength;

// 玻璃边缘宽度（像素）
uniform float edgeWidthPx;

// 折射率
uniform float ior;

// 玻璃基底明暗
uniform float brightness;

// 豁免矩形（像素坐标）：x,y,w,h — 当 w,h > 0 时，豁免矩形内的像素直接 discard
uniform vec4 exemptPx;

// 时间（秒）——建议你用"平滑累计小时间"传入
uniform float time;
uniform float flowStrength;   // 0~1
uniform float flowScale;      // px scale

// ===== 可选：液体散射（轻量版）=====
// 如果你不想要散射，把 scatterDirections 设为 0 或 1 即可
uniform float scatterSizePx;       // 建议 6~14
uniform int scatterDirections;     // 0~6（建议 4~6）
uniform int scatterQuality;        // 1~3（建议 1~2）

// ---------- SDF: Rounded Rect (pixels) ----------
float sdfRoundRectPx(vec2 p, vec2 center, vec2 halfSize, float r)
{
    vec2 q = abs(p - center) - (halfSize - vec2(r));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// 玻璃表面高度（用于折射长度）
float glassHeight(float sd, float t)
{
    if (sd >= 0.0) return 0.0;
    if (sd < -t) return t;
    float x = t + sd;
    return sqrt(max(t*t - x*x, 0.0));
}

// 用有限差分估计 SDF 梯度（避免 dFdx/dFdy）
vec2 sdfGrad(vec2 p, vec2 center, vec2 halfSize, float r)
{
    float e = 1.0;
    float s1 = sdfRoundRectPx(p + vec2(e, 0.0), center, halfSize, r);
    float s2 = sdfRoundRectPx(p - vec2(e, 0.0), center, halfSize, r);
    float s3 = sdfRoundRectPx(p + vec2(0.0, e), center, halfSize, r);
    float s4 = sdfRoundRectPx(p - vec2(0.0, e), center, halfSize, r);
    return vec2(s1 - s2, s3 - s4) * 0.5;
}

float fresnelSchlick(float cosTheta, float R0)
{
    return R0 + (1.0 - R0) * pow(1.0 - cosTheta, 5.0);
}

// hash（用于轻微 jitter，避免散射采样出现环纹）
float hash(vec2 p)
{
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main()
{
    vec2 p = fragTexCoord * resolution;

    // 豁免矩形：直接 discard，让下层内容透出
    if (exemptPx.z > 0.0 && exemptPx.w > 0.0 &&
        p.x >= exemptPx.x && p.x < exemptPx.x + exemptPx.z &&
        p.y >= exemptPx.y && p.y < exemptPx.y + exemptPx.w) {
        discard;
    }

    vec2 rectMin = rectPx.xy;
    vec2 rectMax = rectPx.xy + rectPx.zw;
    vec2 center  = (rectMin + rectMax) * 0.5;
    vec2 halfSz  = (rectMax - rectMin) * 0.5;

    float sd = sdfRoundRectPx(p, center, halfSz, cornerRadiusPx);

    float aa = 1.0;
    float alpha = 1.0 - smoothstep(0.0, aa, sd);

    // 区域外透传
    if (alpha <= 0.001) {
        gl_FragColor = texture2D(texture0, fragTexCoord);
        return;
    }

    // 边缘权重（0=中心，1=靠边）
    float edge = 1.0 - smoothstep(-edgeWidthPx, 0.0, sd);
    edge = clamp(edge, 0.0, 1.0);

    // 法线（厚度曲面）
    vec2 g = sdfGrad(p, center, halfSz, cornerRadiusPx);

    float t = max(thicknessPx, 0.001);
    float n_cos = clamp(max(t + sd, 0.0) / t, 0.0, 1.0);
    float n_sin = sqrt(max(1.0 - n_cos * n_cos, 0.0));
    vec3 normal = normalize(vec3(g.x * n_cos, g.y * n_cos, n_sin));

    vec3 incident = vec3(0.0, 0.0, -1.0);

    float h = glassHeight(sd, t);

    // ===== 流动（保留你说的"流动边缘"）=====
    float wave = sin((p.x + p.y) / max(flowScale, 1.0) + time) *
                 cos((p.x - p.y) / max(flowScale, 1.0) + time * 1.2);
    float flow = wave * flowStrength;

    // ===== 折射：边缘更强 + 带 flow =====
    // 这里你可以让边缘更激进：edge -> pow(edge, 1.2~1.8)
    float edgePow = pow(edge, 1.35);

    // 参考你那份：distortionPx*(0.35+0.65*edge) + distortionPx*0.35*flow
    // 我这里保留结构，但用 edgePow 让边缘更"液体"
    float refrStrength = distortionPx * (0.35 + 0.65 * edgePow)
                       + distortionPx * 0.35 * flow;

    float n1 = 1.0;
    float n2 = max(ior, 1.001);
    float eta = n1 / n2;

    vec3 refr1 = refract(incident, normal, eta);
    float denom1 = max(dot(vec3(0.0, 0.0, -1.0), refr1), 0.05);
    float len1 = h / denom1;

    vec2 baseOffsetPx = -refr1.xy * len1 * refrStrength;

    // ===== 可选：液体散射（轻量多方向采样，保留"液体边缘"）=====
    // 采样数 = scatterDirections * scatterQuality
    // GLES100 需要固定上限
    const int MAX_DIR = 6;
    const int MAX_Q   = 3;

    vec3 accum = vec3(0.0);
    float wsum = 0.0;

    if (scatterDirections <= 1 || scatterQuality <= 1 || scatterSizePx <= 0.01)
    {
        // 单次采样（更快）
        vec2 uv = clamp((p + baseOffsetPx) / resolution, vec2(0.0), vec2(1.0));
        accum = texture2D(texture0, uv).rgb;
        wsum = 1.0;
    }
    else
    {
        for (int di = 0; di < MAX_DIR; di++)
        {
            if (di >= scatterDirections) break;

            float a = (float(di) + 0.5) / float(scatterDirections) * 6.2831853 + time * 0.15;
            vec2 dir = vec2(cos(a), sin(a));

            for (int qi = 1; qi <= MAX_Q; qi++)
            {
                if (qi > scatterQuality) break;

                float u = float(qi) / float(scatterQuality);

                // 边缘更强散射（中心更清晰）
                float rPx = scatterSizePx * u * (0.15 + 0.85 * edgePow);

                // jitter 防止出现"同心环"
                float rnd = hash(fragTexCoord * resolution * 0.02 + vec2(float(di), float(qi)));
                float jitter = (rnd - 0.5) * 0.6;

                vec2 offPx = baseOffsetPx + dir * rPx * (1.0 + jitter);
                vec2 uv = clamp((p + offPx) / resolution, vec2(0.0), vec2(1.0));

                // 权重：越外圈权重越小，避免发灰
                float w = 1.0 / (1.0 + u * 1.5);

                accum += texture2D(texture0, uv).rgb * w;
                wsum  += w;
            }
        }
    }

    vec3 refrCol = accum / max(wsum, 1e-4);

    // ===== 高光：完全沿用你那份（关键！）=====
    float cosTheta = clamp(normal.z, 0.0, 1.0);
    float R0 = pow((n1 - n2) / (n1 + n2), 2.0);
    float fres = fresnelSchlick(cosTheta, R0);

    float rim = fres * (0.15 + 0.85 * edge) * highlightStrength;
    vec3 rimCol = vec3(0.85, 0.92, 1.0) * rim;

    // 玻璃基底（先算）
	vec3 base = mix(vec3(0.55), refrCol, 0.75);

	// ===== 玻璃明暗控制（只影响基底，不影响高光）=====
	base *= brightness;

	// 再叠加高光（保持凸出感）
	vec3 outCol = base + rimCol;

    vec3 bg = texture2D(texture0, fragTexCoord).rgb;
    vec3 finalCol = mix(bg, outCol, alpha);

    gl_FragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
}
