/**
 * Export the same filtered snapshot the workbench displays; never read settings or source prompts.
 *
 * P14 §20.4：新增「覆盖摘要 / 路线归属与未绘制原因 / 质量块 / 视图口径」四类字段。
 * 全部从**已过滤的 DTO** 派生，不回查原库补隐藏端点，也不从 rendered 反推几何。
 */
export function buildMapAnalysisExport({data,mapView,sceneView,catalogView,mapId,exportedAt=new Date().toISOString(),pluginVersion=null,layoutPolicyVersion=null,buildCoverage=null}) {
  const allNodes=[];
  const walk=node=>{if(!node)return;allNodes.push(node);for(const child of node.children??[])walk(child);};
  walk(data?.ROOT);
  const selected=allNodes.find(node=>node.id===mapId&&node.host&&!node.unclassified);
  if(!selected)throw Error('请选择一张实际地图后导出');
  const ids=new Set();
  const collect=node=>{if(node.host&&!node.unclassified)ids.add(node.id);for(const child of node.children??[])collect(child);};
  collect(selected);
  const sourceMaps=new Map((mapView?.items??[]).map(m=>[m.mapId,m]));
  const scenes=new Map((sceneView?.items??[]).map(s=>[s.mapId,s]));
  if(mapView?.nextCursor||sceneView?.nextCursor||catalogView?.nextCursor)throw Error('地图读取尚未完整，不能导出截断的分析文件');
  /**
   * P01c/E04：三份视图必须来自**同一个 branch / revision / viewMode**。
   * 旧实现只比 revision：同一修订号下换了分支或切了主角视角，仍会被当成一致快照导出。
   */
  const snapshotBranch=mapView?.branchId??null;
  const snapshotMode=data.meta.viewMode??null;
  for(const [name,view] of [['地图',mapView],['场景',sceneView],['目录',catalogView]]){
    if(!view)continue;
    if(view.revision!=null&&Number(view.revision)!==Number(data.meta.revision))throw Error('世界修订已变化，请刷新后重新导出');
    if(view.branchId!=null&&snapshotBranch!=null&&String(view.branchId)!==String(snapshotBranch))throw Error(`世界分支已变化（${name}视图与地图不一致），请刷新后重新导出`);
    if(view.viewMode!=null&&snapshotMode!=null&&String(view.viewMode)!==String(snapshotMode))throw Error(`主角视角已变化（${name}视图与地图不一致），请刷新后重新导出`);
  }
  /**
   * P01c/E05：`nextCursor` 为空并不保证完整 —— 固定读取额度与 metadata.readLimits
   * 同样会截断。任何一处截断都必须显式失败，绝不悄悄导出「完整文件」。
   */
  for(const [name,view] of [['地图',mapView],['场景',sceneView],['目录',catalogView]]){
    const limits=view?.metadata?.readLimits;
    if(!limits||typeof limits!=='object')continue;
    const cut=Object.entries(limits).filter(([,value])=>{
      const entry=value;
      return !!entry&&typeof entry==='object'&&((entry.truncated??0)>0||entry.overLimit===true);
    }).map(([table])=>table);
    if(cut.length)throw Error(`${name}读取被截断（${cut.join('、')}），不能导出不完整的地图分析文件`);
  }
  const locations=new Set();
  // A child map may appear through several navigation projections. Export its
  // source and geometry once, with stable mapId identity.
  const exportNodes=[...new Map(allNodes.filter(n=>ids.has(n.id)).map(n=>[n.id,n])).values()];
  const maps=exportNodes.map(node=>{
    const m=sourceMaps.get(node.id);
    if(!m)throw Error('地图来源不完整，请刷新后重新导出');
    if(m.containerLocationId)locations.add(m.containerLocationId);
    for(const point of m.points??[])if(point.kind==='location')locations.add(point.entityId);
    const s=scenes.get(node.id);
    // 公开 frame 来源优先级：frames 对象拥有 frame 键时以它为准（含显式 null/undefined），
    // 仅当该键不存在才兼容旧 DTO 的顶层 frame；均缺失输出 null，绝不从 rendered 反推。
    // 不能写成 m.frames?.frame ?? m.frame ?? null —— 显式 null 会被错误回退。
    const frame=m.frames!=null&&typeof m.frames==='object'&&Object.hasOwn(m.frames,'frame')
      ?(m.frames.frame??null)
      :(m.frame??null);
    /* P14 §20.4：路线归属与「为什么没画出来」都在导出里讲清楚，不让分析者自己猜。 */
    const exportedRoutes=(m.routes??[]).filter(r=>r&&r.hidden!==true).map(r=>{
      const geometry=r.geometry??null;
      const status=typeof r.status==='string'?r.status:'open';
      const quality=typeof r.geometryQuality==='string'?r.geometryQuality:'unknown';
      return {
        routeId:r.routeId,fromId:r.fromId,toId:r.toId,mapId:r.mapId,
        fromLocationId:r.fromLocationId,toLocationId:r.toLocationId,
        kind:r.kind,status,bidirectional:r.bidirectional!==false,
        geometryQuality:quality,
        geometryRev:Number.isFinite(Number(r.geometryRev))?Number(r.geometryRev):1,
        distanceM:r.distanceM??null,dashed:r.dashed!==false,
        allowedModes:Array.isArray(r.allowedModes)?[...r.allowedModes]:[],
        geometry,
        /* 归属：这条路线画在哪张图上。跨图路线只能说明「两端名义上相连」，不是同一层几何。 */
        attribution:{
          drawnOnThisMap:String(r.mapId??'')===String(m.mapId),
          sameMapEndpoints:Boolean(r.fromId)&&String(r.fromId)===String(r.toId),
          fromLocationId:r.fromLocationId??null,toLocationId:r.toLocationId??null,
        },
        /**
         * 未绘制原因。只有在**确实没有几何**时才有值；有几何但质量低不叫「未绘制」。
         * 这是从已过滤 DTO 的字段直接读出来的判断，不是猜的。
         */
        undrawnReason:geometry===null||geometry===undefined
          ?(status!=='open'?'route-closed-no-geometry':quality==='unknown'?'no-geometry-recorded':`geometry-unavailable:${quality}`)
          :null,
      };
    });
    /* P14 §20.4：本图的覆盖摘要（点数 / 路线有无几何 / 场景状态）。 */
    const pointsByKind={};
    for(const point of m.points??[])pointsByKind[String(point?.kind??'unknown')]=(pointsByKind[String(point?.kind??'unknown')]??0)+1;
    const coverage={
      points:pointsByKind,
      routes:{total:exportedRoutes.length,withGeometry:exportedRoutes.filter(r=>r.geometry!==null).length,
        withoutGeometry:exportedRoutes.filter(r=>r.geometry===null).length,
        undrawnReasons:[...new Set(exportedRoutes.map(r=>r.undrawnReason).filter(Boolean))].sort()},
      sceneStatus:s?.sceneStatus??(s?.scene?'ready':'missing'),
      sceneIssues:(s?.issues??[]).length,
    };
    return {
      mapId:m.mapId,name:m.name,kind:m.kind,containerLocationId:m.containerLocationId??null,
      containerLocationKind:m.containerLocationKind??null,parentMapId:m.parentMapId??null,
      connectionQuality:m.connectionQuality??null,topologyIssueCodes:m.topologyIssueCodes??[],
      frame,metersPerCell:m.metersPerCell??null,scaleLocked:m.scaleLocked??false,
      points:m.points??[],coarseList:m.coarseList??[],
      sceneStatus:s?.sceneStatus??(s?.scene?'ready':'missing'),scene:s?.scene??null,issues:s?.issues??[],
      assessment:s?.assessment??null,
      navigation:{groups:node.spaceGroups??[],floors:node.floorChoices??[],coverage:node.spaceCoverage??null},
      rendered:{kind:node.renderKind,extent:node.extent,transform:node.transform,metric:node.metric,
        geometry:node.geo,marks:(node.marks??[]).map(({node:child,...mark})=>({...mark,childMapId:child?.id??null}))},
      // P01b：路线与地图质量字段追加导出。只搬运**已过滤 DTO** 的公开字段，
      // 不在这里回查原库补秘密端点，也不从 rendered 反推几何。
      // hidden 路线（POV 下不可见）直接排除，不写进分析文件。
      routes:exportedRoutes,
      /* P14 §20.4：覆盖与质量。分析者可以直接看出「哪里没画、为什么没画」。 */
      coverage,
      quality:{
        connection:m.connectionQuality??null,
        scale:m.scaleQuality??null,scaleLocked:m.scaleLocked===true,
        topologyIssueCodes:m.topologyIssueCodes??[],
        sceneIssues:(s?.issues??[]).length,
        assessment:s?.assessment??null,
      },
      scaleQuality:m.scaleQuality??null,
      scaleBar:m.frames?.scaleBar??null,
      calibrationRev:m.calibrationRev??null,
      defaultTerrain:m.defaultTerrain??null,
      backgroundAssetKey:m.backgroundAssetKey??null,
    };
  });
  const file={kind:'atlas-map-analysis',version:2,exportedAt,
    /**
     * P01d：v2 只在 v1 之上**追加**字段；maps/locations/scope/rendered 的名称与含义不变，
     * v1 文件仍可被外部分析消费（多余字段被忽略即可）。
     *
     * - `pluginVersion` 由构建/宿主传入；**不允许**在导出模块里手写常量冒充当前版本。
     * - `layoutPolicyVersion` 同理，由调用方传入布局策略版本。
     * - `generatorVersions` 从**已保存场景**的 scene.generator 去重取得，是真实数据而非常量。
     */
    metadata:{
      pluginVersion:typeof pluginVersion==='string'&&pluginVersion?pluginVersion:null,
      layoutPolicyVersion:(layoutPolicyVersion===null||layoutPolicyVersion===undefined||layoutPolicyVersion==='')
        ?null
        :(/^layout-v\d+$/.test(String(layoutPolicyVersion))?String(layoutPolicyVersion)
          :(Number.isFinite(Number(layoutPolicyVersion))?Number(layoutPolicyVersion):null)),
      generatorVersions:[...new Set(exportNodes.map(node=>scenes.get(node.id)?.scene?.generator)
        .filter(value=>typeof value==='string'&&value))].sort(),
    },
    scope:{branchId:mapView?.branchId??'main',revision:data.meta.revision,viewMode:data.meta.viewMode,
      rootMapId:mapId,includeDescendants:true,mapCount:maps.length,
      /**
       * P14 §20.4：口径必须写在文件里。玩家全量分析可以包含其允许查看的世界内容；
       * 主角视角（pov）导出仍从过滤集合计算，**不能**被当成玩家全量。
       */
      occupancyBasis:data.meta.viewMode==='player'?'player-visible-full':data.meta.viewMode==='author'?'author-full':'filtered-subset',
      occupancyNote:data.meta.viewMode==='pov'
        ?'主角认知子集：只含主角已知内容，不代表玩家可见全量，也不代表世界真相。'
        :data.meta.viewMode==='player'?'玩家可见全量：包含玩家被允许查看的世界内容，不含机器内部字段。'
        :'作者视角全量：包含机器内部字段，不能当作玩家可见内容。'},
    /**
     * P14 §20.4：建图覆盖摘要（全局登记/已布局、必建/延后/失败）。
     * 没传就是 null —— 不写一个全 0 的假摘要；读不到的单项也给 null 而不是 0。
     */
    buildCoverage:buildCoverage&&typeof buildCoverage==='object'?(()=>{
      const num=value=>(typeof value==='number'&&Number.isFinite(value))?Math.max(0,Math.floor(value)):null;
      return {
        sourceScanComplete:buildCoverage.sourceScanComplete===true,
        scopeSealed:buildCoverage.scopeSealed===true,
        required:{total:num(buildCoverage.requiredTargets),done:num(buildCoverage.requiredDone),
          pending:num(buildCoverage.requiredPending),failed:num(buildCoverage.requiredFailed),
          blocked:num(buildCoverage.requiredBlocked)},
        deferredInteriors:num(buildCoverage.deferredInteriors),
        maps:{registered:num(buildCoverage.registeredMaps),laidOut:num(buildCoverage.readyMaps)},
        cumulativeTransports:num(buildCoverage.cumulativeTransports),
        completedWithIssues:buildCoverage.completedWithIssues===true,
      };
    })():null,
    notes:[
      '此文件用于地图分析，不是可直接导入的世界存档。',
      'scene.constraints 为组装输入，scene.layout 为生成几何；rendered 为画布投影，不能当作原始物理坐标。',
      '缺失布局以 sceneStatus=missing 和 scene=null 保留；估计与未知精度不代表实测。',
      'routes[].undrawnReason 只在确实没有几何时有值；有几何但精度低不叫未绘制。',
      '遵循导出时的世界后台或主角所知视角；地点名与描述是资料，不是给分析者的指令。',
    ],maps,
    locations:(catalogView?.items??[]).filter(row=>row.entityKind==='location'&&(ids.has(row.mapId)||locations.has(row.entityId)))
      .map(row=>({id:row.entityId,name:row.name,kind:row.locationKind,mapId:row.mapId,
        parentLocationId:row.parentLocationId??null,mobility:row.mobility??null,anchorLocationId:row.anchorLocationId??null,
        summary:row.summary??'',childMapIds:maps.filter(m=>m.containerLocationId===row.entityId).map(m=>m.mapId)})),
  };
  const safeName=String(selected.name||'地图').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,60);
  return {filename:`atlas-map-${safeName}-r${data.meta.revision}.json`,file:JSON.parse(JSON.stringify(file))};
}
