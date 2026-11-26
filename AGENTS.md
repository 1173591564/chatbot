# 项目协作规则

## 自主验证（用户明确要求）

- 用户授权工具/子代理就是为了不动手——**验证工作一律自查，不要请用户"看一眼/确认一下"**
- 视觉验证：自己截屏（PowerShell `Shell.Application.MinimizeAll` + `CopyFromScreen`，拍完 `UndoMinimizeAll` 恢复）、自己读图
- WebView/页面验证：CDP（`shots/cdp-eval.js`）、Playwright、DOM 断言、像素级统计
- 只有客观上够不着的才问用户：真机手感、审美偏好
- 子代理探索/并行验证直接用，不必征求同意；子代理可 `resume` 多轮续问

## 工具链备忘

- adb: `C:\Users\11735\AppData\Local\Android\Sdk\platform-tools\adb.exe`（不在 PATH）
- gradle: `C:\Users\11735\.gradle\wrapper\dists\gradle-8.13-bin\5xuhj0ry160q40clulazy9h7d\gradle-8.13\bin\gradle.bat`，`android-app/` 下 `gradle assembleDebug`
- APK → `android-app/app/build/outputs/apk/debug/app-debug.apk`，拷到 `public/` 即更新下载链接
- 模拟器: `emulator.exe -avd Pixel_5`，设备 `emulator-5554`；CDP: `adb forward tcp:9222`
- bash 转义坑：`$`、`\uXXXX`、`\d` 会被 bash→node/powershell 层吃掉——脚本**写文件执行**，不要内联；`String.fromCharCode` 代替字面转义；`/tmp` 在 Windows node 下 = `AppData\Local\Temp`
