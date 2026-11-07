# 发布手册 / PUBLISHING

> 发布前一次性配置完成后，按本手册执行即可。所有检查已在本地验证通过（`npm run check` 全绿）。

## 0. 前置条件

- [ ] GitHub 账号（用于开源仓库）
- [ ] npm 账号（用于 `npm publish`；首次发布建议创建 **automation** 类型的 access token）
- [ ] 决定包名：`dsh-aa-bridge-doctor`（已在 package.json 中，如需改名先改 package.json + cordis.patch.yml 的 name）

## 1. GitHub 仓库

```bash
cd dsh-aa-bridge-doctor
git remote add origin git@github.com:<你的账号>/dsh-aa-bridge-doctor.git
git push -u origin main          # 本地已有 4+ 个提交，工作区干净
```

仓库建议设置：

- Description: `Detect & auto-recover Agents Anywhere bridge wedge for DeepSeek Harness (device permanently offline on your phone) — 桥接医生`
- Topics: `deepseek-harness`, `agents-anywhere`, `dsh-plugin`, `watchdog`, `self-healing`
- 开启 Issues

## 2. npm 发布

```bash
npm login                        # 或: npm config set //registry.npmjs.org/:_authToken=<token>
npm run check                    # 最终验证（typecheck + build + 30 测试）
npm publish                      # prepublishOnly 会再跑一遍 check + pack 干跑
```

发布后在 npm 包页完善 README（会自动使用仓库的 README.md）。

## 3. 验证发布物

```bash
npm view dsh-aa-bridge-doctor
npm pack dsh-aa-bridge-doctor && tar -tzf dsh-aa-bridge-doctor-*.tgz   # 应含 lib/ cordis.patch.yml README LICENSE
```

在一台干净机器上按 README「安装」章节实测一遍（方式 C 手动流程已在开发机演练通过）。

## 4. 上游 issue

- 草稿在仓库外一份：`../upstream-issue-draft.md`（相对本目录）
- 目标：[#381](https://github.com/anywhere-labs/Agents-Anywhere/issues/381) 追加评论（或开新 issue 引用 #381/#501/dsh-desktop#1334）
- 提交前替换占位符（机器信息），删掉文末中文对照小节

## 5. 版本策略

- 修复：patch（0.1.x）
- 新检测签名/新恢复动作：minor（0.x.0）
- `CHANGELOG.md` 每次发版必须更新
- 上游修复落地后：在 README 标注「自 AA vX.Y 起上游已修复 A/B，本插件仅覆盖 C缺口」并继续维护检测告警层
