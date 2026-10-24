# 地图收纳与生成流程

## 地图界面

地图默认只保留「地图工具」入口，展开后显示地点卡、视图选择、缩放/网格/导出、小地图、图例、比例尺和状态条。再次点击收起；工具区隐藏时不参与键盘焦点或鼠标命中，焦点若仍在工具区会先回到入口。

原来的四个视图按钮合为原生选择框。完整界面、地图优先、仅地图仍沿用各自的组件权限；切换显示配置不会覆盖收纳偏好。工作区设置页隐藏地图浮层。选中对象的详情独立于工具区，地图拖动、滚轮缩放、命中与 `F` 适应视野保持可用。

收纳偏好写入现有宿主交互设置，版本升级为 3，同时读取 1/2/3；旧设置缺少此字段时默认收起。图例自身的折叠状态仍独立保存。隐藏不替换 Canvas，不重置地图、相机或对象选择，不调用生成/推演，不写世界数据库；展开时重新测量小地图的像素尺寸，主视口尺寸不变。

## 地图生成

地图布局仍由模型提交语义约束、程序求几何。没有新增外部文生图服务或发送图片 API 请求。

- 依据本批实际 `kind` 提供 overview/city/floor 规则，避免室内请求夹带河流、城市分区等参数。混合批次保留实际包含的各类规则。
- 移除通用默认大小对实际 `extent/spaceSize/childSpaces` 的暗示性覆盖。
- floor 示例不再预填 `contents:[]`，overview 示例不再预填全部空数组；明确初次生成要覆盖已登记空间，更新只修缺项和 `layoutIssues`，不能把示例照抄为空布局。
- 保留父子空间、物理尺寸权威、陈设稳定 ID、显式删除、锁定结构、人物/物品真实引用及来源摘录。尺寸矛盾在 `why` 说明，不能缩小已确认空间凑成功。
- 最终任务与预设注入的预览副本完全一致。现有程序校验、失败回执和请求预算继续生效。

这些是请求内容与输入机制的改进；离线回归不能证明所有外部模型的实际输出质量都会提高，仍需使用已配置模型实测。

## 皮肤素材生成

复用 manifest 中的角色引用与配色，为每个独立资源生成一条任务，同一个边框被多个角色共用时不重复生图。生成计划明确 `transparent_background`，地图标记按实际 **24×24 CSS px** 审查，头像框按 38/48 px 审查，背景保持中央留白，窗框与圆环头像框分开。

```sh
python3 -m pip install -r tools/requirements-artwork.txt
mkdir -p .tmp
node tools/artwork-prompts.mjs skins/qingkong-xinjian > .tmp/qingkong-prompt-plan.json
```

计划仅准备提示词，不自动调用模型。使用图像生成工具执行各条任务并保留原始结果、提示词、来源和裁切依据；旧素材的来源记录继续保留。

对已有生成结果，只做明确裁切、等比缩放和编码：

```sh
python3 tools/artwork-image.py prepare .tmp/generated-character.png .tmp/character.png --size 96 96
python3 tools/artwork-image.py prepare .tmp/generated-frame.png .tmp/frame.png --crop 40 40 512 512 --size 256 256 --mode cover
```

默认 `contain` 不拉伸、不裁边，输出尺寸可能小于目标框；`cover` 明确允许等比裁边。原文件不可作为输出覆盖。透明通道保留，不靠颜色猜背景或给旧图程序绘制替代纹样。

```sh
python3 tools/artwork-image.py audit skins/qingkong-xinjian
node tools/build-qingkong-skin.mjs .tmp/Atlas-QingkongXinjian.zip
npm run test:artwork
```

打包先通过现有 ZIP/主题验证，再用 Pillow 真正解码所有图片，检查类型、动画、尺寸和总像素预算，并拒绝窗框冒充头像框、非方形或中心不透明的头像框。最后用临时文件原子替换 ZIP；检查失败保留原 ZIP。

自动检查不判断美术质量。仍要在 24px 标记、圆头像、九宫格边框、两种显示基底和窄屏上检查辨识度、文字对比及切换时几何是否稳定。Python/Pillow 仅用于离线制作，用户导入 ZIP 的浏览器运行路径不受影响。

## 验证入口

```sh
npm run typecheck
npm test
npm run test:artwork
npm run pack
npm run verify:map-widgets
node tools/verify-reference-browser.mjs
node tools/verify-reference-browser.mjs --skins-only
node tools/verify-artwork-skin.mjs
```

浏览器验收运行真实打包扩展与 SQL 宿主夹具，覆盖工具收纳、键盘、焦点、重开偏好、360–1440px、三种界面配置与两种基底；并保留已有皮肤导入、资源释放、几何与命中检查。
