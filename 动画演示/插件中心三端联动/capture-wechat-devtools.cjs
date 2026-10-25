const path = require("path");
const automator = require(path.resolve(__dirname, "../../output/miniprogram-automation/node_modules/miniprogram-automator"));

(async () => {
  const miniProgram = await automator.launch({
    // 微信开发者工具的 CLI 路径按本机安装位置传环境变量，别把个人目录写进仓库。
    cliPath: process.env.WX_DEVTOOLS_CLI || "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat",
    projectPath: path.resolve(__dirname, "../../miniprogram"),
    port: 32552,
    trustProject: true,
    timeout: 120000,
  });
  try {
    await miniProgram.reLaunch("/pages/plugins/index");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const current = await miniProgram.currentPage();
    console.log(`Current WeChat page: ${current.path}`);
    console.log("System:", await miniProgram.systemInfo());
    await miniProgram.screenshot({ path: path.join(__dirname, "real-wechat-plugin-center.png") });
  } finally {
    miniProgram.disconnect();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
