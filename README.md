# Kaola Skills

考拉 Skills 梳理各种 AI 视频的流程，目标是帮你快速产出高质量的 AI 带货视频。

## 总览

![Kaola Skills 总览](docs/kaola-skills-overview.gif)

## 包含内容

- `kaola`：根据当前视频任务路由到合适的子 Skill。
- `kaola-setup`：引导配置 MiniMax、阿里云 OSS，以及可选的 GPT Image Two。
- `kaola-lapian`：对用户有权分析的视频进行抽帧、转写和结构化拉片。
- `kaola-daihuo`：把商品素材和已确认卖点整理为电商短视频分镜与提示词。
- `kaola-fuke`：保留原视频结构，仅替换指定人物、服装、商品或 Logo。
- `kaola-maidian`：把产品功能转化为可见的发布会式卖点演示。

## 安装

### Plugin 安装（推荐）

在终端依次运行：

```bash
codex plugin marketplace add kaola-ai/kaola-skills
codex plugin add kaola-skills@kaola-ai
```

安装后，在插件目录中可以直接看到 **Kaola Skills**，无需再次输入 GitHub 仓库地址。

### 手动安装 Skills

将本仓库的 `skills/` 内各目录复制到你的 Codex 项目 `.agents/skills/` 目录；随后可在对话中使用 `$kaola` 或对应子 Skill 名称。

`kaola-lapian` 的本地处理脚本需要 FFmpeg、FFprobe 和 Pillow。若要使用 SenseVoice 转写，请在你自己的 Python 环境中安装 `funasr`、`torch` 与 `torchaudio`，并按服务自身要求准备模型。

## 使用前必须准备

1. **阿里云 OSS（必须）**：[打开阿里云 OSS 注册与开通页面](https://www.aliyun.com/product/oss)。注册阿里云账号并开通 OSS，用于存储和提供图片、视频素材链接。还需要准备 Bucket、RAM 用户和 AccessKey。
2. **MiniMax（必须）**：[打开 MiniMax 开放平台](https://platform.minimaxi.com/)。注册账号并创建 API Key，用于执行 MiniMax H3 视频生成。
3. **GPT Image Two（建议，非必须）**：[打开 Grsai GPT Image Two 后台](https://grsai.com/zh/dashboard)。只在需要生成新的人脸参考图时优先使用。没有配置时，Kaola 会直接使用系统内置的图片生成能力，不会阻塞任务。

不知道如何配置时，安装后直接使用 `$kaola-setup`。MiniMax 和 Grsai 会给出注册入口；阿里云账号登录后，会引导创建私有 Bucket、RAM 专用用户和最小权限。不要把 API Key 或 AccessKey 提交到 GitHub。

## 开源许可

本项目采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)（署名—非商业性使用 4.0 国际）许可。

- 非商业使用、学习、研究和修改均可；
- 公开分享原作或衍生作品时，请保留来源、许可证链接，并标注修改；
- 商业使用需先取得版权所有者的单独授权。

## 交流合作

欢迎扫码添加微信，交流 AI 视频创作与合作。

![微信交流合作](docs/wechat-contact.jpg)
