# 番茄计时卡着色器

`liquid_glass.fs` 和 `roundrect.fs` 来自用户提供的 JackalClient 本地资源，作者 Wormwaker / Wormwake Studio。保留原文件，不为其另行授予开源许可。

`pomodoroGlass.js` 是这两个文件的 WebGL 2 适配文本：仅将版本声明、输入输出与纹理采样语法转成 GLSL ES 3.00，原 SDF、折射、散射和 Fresnel 公式保留。计时文字与按钮由 DOM 绘制，不进入背景纹理。

`pomodoroGlassBlur.js` 根据同一批本地资源中的 `neverlose_title_blur.fs` 和本地「折光实验室」的柔焦实现改写为计时卡专用采样。圆角切片着色来自本地实验室的原创简化片元着色器。

当前用于用户授权的本地开发。公开分发这些第三方着色器前需取得原作者的相应许可。
