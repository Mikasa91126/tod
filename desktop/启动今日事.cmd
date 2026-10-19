@echo off
rem 今日事 · 桌面版（Electron）双击入口
rem 日常建议直接用桌面「今日事」快捷方式；这个文件是文件夹内的备用入口
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
