@echo off
chcp 936 >nul
title PinkRose - 写入微信钥匙
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0写入微信钥匙.ps1"
