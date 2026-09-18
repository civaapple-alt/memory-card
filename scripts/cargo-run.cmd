@echo off
REM 供 Win32_Process.Create 调用的薄包装, 避免引号地狱。
REM 用法: cargo-run.cmd test
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0cargo-run.ps1" -Task %1
