# Barnacle

**一个自托管的像素办公室，让你的 AI Agent 像团队一样协作。**

[English](README.md) · 简体中文

![Barnacle 办公室：各部门的小人在工位上工作，还有会议室、休息室、机房和董事长办公室](docs/images/office-zh.png)

Barnacle 把你的 AI Agent 变成一家看得见的小公司。每个 Agent 有自己的职位、灵魂（SOUL）和技能，在某个部门有固定工位，还有一个像素小人：写东西时坐回工位，查资料时去图书区，跑任务时去机房。它们会互相求助、委派工作，在项目讨论串里接力，每天向部门经理汇报；只有你（董事长）才能决定的事，会送到你桌上。

可以部署在自己的服务器、NAS 或笔记本上。模型随你选：Claude、OpenAI、Gemini、DeepSeek、MiniMax、OpenRouter、Ollama，或任何 OpenAI 兼容接口。Claude Code、Codex 这类工具也可以出现在办公室里。

> **状态：** 早期原型（v0.1），会有不完善和不兼容的改动。

## 功能

- **有灵魂的 Agent**：职位、人设（SOUL）、工作方式和技能库，每人可用不同模型；分层记忆，能全文检索过去做过的事。
- **团队，而不是一堆机器人**：Agent 会向同事提问、委派部分工作；项目以讨论串进行，@ 谁就交给谁，自动规划与总结。
- **公司架构（可选）**：房间即部门，部门经理每天写日报；CEO 汇总全公司，并依照你过去的决定代你审批你授权的事；董事长工作台一览全局。
- **你始终掌控**：每类动作可设「允许 / 先问我 / 禁止」；收件箱集中审批；成果页逐件验收或退回重做，并可查看引用来源；经验库与技能变更都要你批准。
- **真实的工作输入输出**：任务可附 PDF、Word、Excel、PowerPoint 和图片；公司与部门知识库，Agent 检索并标明出处；交付物可以是 Word、Excel、CSV 或 Markdown 文件。
- **成本可控**：每次调用记录 token 与估算费用，按人、部门、模型汇总；每日 / 每月预算；例行工作改用轻量模型。
- **接入你的工具**：MCP 服务器（本机或远程），每个工具都走同一套审批规则；定时任务；Claude Code hook 和简单的 HTTP 状态接口。
- **自己设计办公室**：瓦片式楼层编辑器、家具与房间、属于个人的工位；「开公司向导」内置团队模板。
- 界面支持 English、日本語、繁體中文。

## 快速开始

### Docker

```bash
git clone https://github.com/xiaoxiongbaba/barnacle.git
cd barnacle
docker compose up -d
docker compose logs barnacle | grep "office token"
```

### 从源码运行（Node.js 22.13+）

```bash
npm install
npm run build
npm start
```

打开 <http://localhost:19100>，点右上角齿轮，输入**办公室令牌**（首次启动时在日志里打印一次，并保存在 `data/secret.json`）。随后「开公司向导」会引导你接入模型、选择团队模板，之后都可以再改。

## 接入你的 Agent

- **在 Barnacle 里的 Agent**：在 设置 → 成员 里给成员配置模型，然后在它的面板里派任务、设定时任务，或发起项目。
- **Claude Code**：用 hook 显示 Claude Code 正在做什么，见 [integrations/claude-code](integrations/claude-code/README.md)。
- **其他任何能发 HTTP 请求的程序**：

  ```bash
  curl -X POST http://localhost:19100/api/occupants/me/status \
    -H "Authorization: Bearer $BARNACLE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"state":"writing","detail":"画大厅草图","name":"我","kind":"human"}'
  ```

  状态：`idle`、`writing`、`researching`、`executing`、`syncing`、`waiting`（需要你）、`error`、`offline`。详见[状态协议](docs/state-protocol.md)。

## 文档

- [使用指南](docs/guide.md)（英文）：模型、记忆、协作、项目、组织架构、审批、文件、成本、MCP、楼层编辑器、环境变量与美术包的详细说明
- [状态协议](docs/state-protocol.md)：草案 v0.1
- [Mod 包规范](docs/mod-pack-spec.md)：草案 v0.1，任何人都能装修办公室
- [需求清单与路线图](docs/REQUIREMENTS.md)

## 配置

大部分设置都在网页里改，环境变量只提供默认值：

| 变量             | 默认值        | 说明                                    |
| ---------------- | ------------- | --------------------------------------- |
| `PORT`           | `19100`       | HTTP 端口                               |
| `HOST`           | `0.0.0.0`     | 监听地址                                |
| `DATA_DIR`       | `./data`      | 数据库、加密密钥和令牌                  |
| `BARNACLE_TOKEN` | 自动生成      | 办公室令牌，至少 32 个字符              |
| `BARNACLE_NAME`  | `My Barnacle` | 默认办公室名称                          |
| `BARNACLE_LANG`  | `en`          | 默认语言：`en`、`ja` 或 `zh-Hant`       |

完整列表见[指南](docs/guide.md#environment-variables)。请备份整个 `DATA_DIR`：数据库和 `master.key` 必须一起保存。

## 安全

- 没有默认密码：每次安装的办公室令牌都是随机的，任何修改都需要它。
- **查看办公室目前不需要登录**（v0.1）。请只在局域网内开放端口，或放在 VPN / 带认证的反向代理后面。
- API Key 和 MCP 密钥加密保存，绝不发送到浏览器。
- Agent 代表你行动：会调用模型、读取网页、使用你接入的 MCP 服务器。请用权限设置、MCP 逐工具规则和预算约束它们。

详见 [SECURITY.md](SECURITY.md)；发现漏洞请私下报告。

## 美术素材

内置美术（人物、家具、地板和墙）全部用代码绘制，来自 Habblaud（MIT）。仓库不包含任何第三方图片素材。如果你购买了 LimeZu 的 *Modern Interiors* / *Modern Office*，可以用脚本在本地生成楼层美术包，素材只留在你自己的机器上，见[美术包](docs/guide.md#art-packs)。

## 参与贡献

欢迎提 Issue 和 Pull Request。较大的改动请先开 Issue 讨论。提交 PR 前请运行 `npm run build`（会对服务端和网页做类型检查）。不要提交 `data/` 或 `packs/local/` 下的任何文件。

## 致谢

灵感来自 [Star Office UI](https://github.com/ringhyacinth/Star-Office-UI)、[Habblaud](https://github.com/marmottajr/habblaud)、OpenClaw、Hermes Agent 和 Clawith。内置像素美术来自 Habblaud，以 MIT 协议收录在 `web/src/vendor/habblaud/`。Pixelify Sans 字体采用 SIL Open Font License。第三方声明见 [NOTICE](NOTICE)。

## 开源协议

[Apache-2.0](LICENSE)。
