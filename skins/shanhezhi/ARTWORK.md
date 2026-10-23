# 山河志素材制作记录

## 1.1 控件素材（2026-10-23）

方式：内置图像生成工具；四张独立透明 PNG。三个框体裁去透明外留边后缩为 256/128/128 px；分隔纹缩为 512×128 px。框体使用静态 PNG 调色板压缩，保留透明度。原始文件一并交付。面板/普通按钮/输入框共享薄金框；激活按钮使用青玉框；朱砂框用于选中项。以下为实际完整提示词。

### panel-frame

```text
Use case: stylized-concept. Production bitmap asset for the Shan He Zhi classical Chinese Atlas UI skin. Match the established palette: warm ivory xuan paper #f4eddd, deep antique jade #255f55, muted bronze gold #947546 and restrained cinnabar #9c3f36. Refined spare linework, flat orthographic 2D graphic, premium classical cartographic style, no photorealistic object, no perspective, no external cast shadow. True transparent background and transparent center, no checkerboard drawn into the art. No text, letters, watermark, page, landscape or UI screenshot. Asset type: a single square 1024x1024 transparent nine-slice panel frame. Thin double bronze gold hairline rectangle with tiny restrained Chinese cloud/return-scroll ornaments only at the four corners. Straight edge rails have uniform thickness, no ornament in their middle. Border sits close to image perimeter with only 24px clear outer margin, all ornament inside outer 130px. At least the central 72% square is completely transparent. Corners modest, airy and clean, distinctly lighter and simpler than an ornate palace window. Designed to scale down to 256px and stretch to very wide or tall panels without stretching corner detail.
```

### control-frame

```text
Use case: stylized-concept. Production bitmap asset for the Shan He Zhi classical Chinese Atlas UI skin. Match the established palette: warm ivory xuan paper #f4eddd, deep antique jade #255f55, muted bronze gold #947546 and restrained cinnabar #9c3f36. Refined spare linework, flat orthographic 2D graphic, premium classical cartographic style, no photorealistic object, no perspective, no external cast shadow. True transparent background and transparent center, no checkerboard drawn into the art. No text, letters, watermark, page, landscape or UI screenshot. Asset type: a single square 1024x1024 transparent nine-slice button frame. Thin dark jade lacquer outline with a fine muted antique gold inlay and four small clipped geometric corners. No ornament or gem in center edges, uniform straight rails, compact functional UI graphic. Border sits within outermost 100px, outer clear margin under 24px, central 78% square completely transparent so a flat color and button label can show through later. Elegant and restrained, crisp silhouette at 128px. Transparent interior, not a filled green button.
```

### selection-frame

```text
Use case: stylized-concept. Production bitmap asset for the Shan He Zhi classical Chinese Atlas UI skin. Match the established palette: warm ivory xuan paper #f4eddd, deep antique jade #255f55, muted bronze gold #947546 and restrained cinnabar #9c3f36. Refined spare linework, flat orthographic 2D graphic, premium classical cartographic style, no photorealistic object, no perspective, no external cast shadow. True transparent background and transparent center, no checkerboard drawn into the art. No text, letters, watermark, page, landscape or UI screenshot. Asset type: a single square 1024x1024 transparent nine-slice selection outline. Restrained cinnabar red seal-ink rectangle, a fine uneven hand printed edge with subtle natural ink grain, tiny dark red corner ticks, absolutely no lettering, no seal characters. A very thin muted gold inner keyline. Clear outer margin under 24px, border confined within the outermost 100px. The central 78% square must be completely transparent. Minimal thin line highlight for selected cards and map tree rows, clear at 128px, no splashes or glowing effects outside the border.
```

### divider

```text
Use case: stylized-concept. Production bitmap asset for the Shan He Zhi classical Chinese Atlas UI skin. Match the established palette: warm ivory xuan paper #f4eddd, deep antique jade #255f55, muted bronze gold #947546 and restrained cinnabar #9c3f36. Refined spare linework, flat orthographic 2D graphic, premium classical cartographic style, no photorealistic object, no perspective, no external cast shadow. True transparent background and transparent center, no checkerboard drawn into the art. No text, letters, watermark, page, landscape or UI screenshot. Asset type: one horizontal 1536x512 transparent section divider ornament. A very thin muted bronze-gold line spans almost the full width, slightly tapering towards both ends. At exact center a tiny spare symmetrical cloud-scroll knot with a single deep jade diamond. All artwork stays in a narrow central horizontal band occupying no more than 14% of the image height, large transparent space above and below. Decoration only; no frame around the image. Designed to display at 12px height as a quiet divider under section titles.
```

## 1.0 基础素材（2026-10-22）

方式：内置图像生成工具；非 CLI/API 后备模式。

三张主图为本次重新生成的素材，未从旧对话取回或冒称复用旧成品。运行素材只做技术性缩放/静态压缩：山水保留1536×1024转WebP，宣纸与框体缩为256×256，框体保留透明通道。六类标点由本项目现有线性图形语汇绘制，制作源在 source-svg/，包内为96×96 PNG。

原始主图随完整素材交付包提供；安装 ZIP 使用优化后的图片。运行包不内嵌文字、模型设置或聊天内容。

## landscape

```text
Use case: stylized-concept. Asset type: production UI backdrop for a Chinese classical fantasy map plugin skin named Shan He Zhi. Create one exquisite horizontal 1536x1024 Chinese blue-green shanshui painting on pale warm ivory xuan paper, hand-painted mineral malachite and azurite, tiny muted antique-gold highlights, mist and finely layered mountain silhouettes, restrained cinnabar details. The middle 65 percent is extremely quiet almost blank warm paper for map lines and UI readability. Clusters of delicate mountains hug the bottom left edge and far right edge, receding to pale jade mist; no objects at the center. Refined museum scroll illustration, subtle real paper fiber. Flat 2D artwork edge to edge, no photographed scroll, no frame, no UI mockup, no lettering, no Chinese text, no seals or symbols, no watermarks. Broad panoramic breathing room, light warm palette, low contrast central region. This is a usable bitmap background not an app screenshot.
```

## paper

```text
Use case: stylized-concept. Asset type: seamless repeating UI paper texture, one square 1024x1024 tile. Create a very subtle seamless warm ivory handmade Chinese xuan paper texture for a premium classical map interface. Uniform illumination, warm light cream roughly #f3ead8, extremely fine natural fibers and tiny sparse flecks. Minimal tonal variation, no large blotches, no vignette, no shadows, no edges, no landscape, no frame, no illustrations, no lettering, no watermark. The left/right and top/bottom edges must tile invisibly. Readable black text will be laid over it. Texture only, not a paper sheet photographed in space.
```

## frame

```text
Use case: stylized-concept. Asset type: one transparent nine-slice window border for a refined Chinese fantasy UI. Square 1024x1024. A perfectly front-facing thin square ornamental frame in muted bronze-gold and dark jade lacquer with restrained Chinese cloud and geometric return-scroll corner ornaments. True transparent alpha everywhere outside the border and in the entire large center. The central 72 percent square must be completely empty transparent. All ornament must fit within the outermost 110 pixels; narrow straight symmetrical edge rails, crisp fine gold inlay, each corner an elegant small square bronze-jade ornament; no shadows or glow spilling into the center, no inner background, no text, no seals, no letters, no watermark. Uniform corners, no perspective, no photographed object, no background chessboard. Production-ready alpha cutout border, elegant spare linework, good legibility scaled down to 256px.
```

