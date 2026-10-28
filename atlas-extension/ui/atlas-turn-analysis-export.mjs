/**
 * Join stored turn summaries with the available safe transport/host diagnostics.
 *
 * P14 §20.2/§20.3：`projection` 是逐轮分析视图逐页下发的 `summary`（楼层/窗口合计、
 * 业务轮计数、建图窗口账）。这里**不重新加总**：只有每一页都给出确定次数时才求和，
 * 否则如实降级成 `null` + 有证据下界——旧日志与留存淘汰都不能被抹成 0。
 */
export function buildTurnAnalysisExport({turns=[],diagnostics=[],scope={},pluginVersion=null,build=null,exportedAt=new Date().toISOString(),totalTurns=turns.length,runtimeCoverage={},projection=[]}={}) {
  const pages=Array.isArray(projection)?projection.filter(page=>page&&typeof page==='object'):[];
  const events=diagnostics.filter(event=>event?.chatFingerprint===scope.chatFingerprint
    &&(!event.details?.branchRef||event.details.branchRef===scope.branchRef));
  const byTurn=new Map();
  for(const event of events){const ref=event.details?.turnRef;if(!ref)continue;if(!byTurn.has(ref))byTurn.set(ref,[]);byTurn.get(ref).push(event);}
  const groups=new Map();
  for(const turn of turns){if(!groups.has(turn.turnRef))groups.set(turn.turnRef,{turnRef:turn.turnRef,storedTurns:[],events:byTurn.get(turn.turnRef)??[]});groups.get(turn.turnRef).storedTurns.push(turn);}
  for(const [ref,list] of byTurn)if(!groups.has(ref))groups.set(ref,{turnRef:ref,storedTurns:[],events:list});
  const rounds=[...groups.values()].map(group=>{
    const {storedTurns,events}=group;
    const persistedCalls=storedTurns.flatMap(turn=>turn.requestAudit?.calls??[]);
    const starts=new Map();
    for(const event of events.filter(event=>event.code==='MODEL_REQUEST_STARTED')){
      const key=event.requestRef?`${event.requestRef}:${event.details?.transportAttempt??1}`:event.id;
      if(!starts.has(key))starts.set(key,event);
    }
    const matched=new Set(persistedCalls.filter(call=>call.requestRef).map(call=>`${call.requestRef}:${call.transportAttempt??1}`));
    const runtimeOnly=[...starts.entries()].filter(([key])=>!matched.has(key)).map(([,event])=>({
      source:'runtime-only',requestRef:event.requestRef,batchRef:event.details?.batchRef,
      workClass:event.details?.workClass??'unknown',stage:event.details?.stage??event.phase,
      reason:event.details?.callReason??'unknown',retryKind:event.details?.retryKind,
      retryOfBatchRef:event.details?.retryOfBatchRef,targetCount:event.details?.targetCount,
      transportAttempt:event.details?.transportAttempt,startedAt:event.at,
      result:events.find(last=>last.requestRef===event.requestRef&&last.details?.transportAttempt===event.details?.transportAttempt
        &&['MODEL_REQUEST_FAILED','MODEL_REQUEST_COMPLETED'].includes(last.code))??null,
    }));
    const knownTotal=storedTurns.length&&storedTurns.every(turn=>Number.isSafeInteger(turn.recordedModelTransports))
      ?storedTurns.reduce((sum,turn)=>sum+turn.recordedModelTransports,0):null;
    const modelStarts=[...starts.values()];
    const completeStoredDetails=storedTurns.length>0&&storedTurns.every(turn=>turn.requestAudit&&turn.requestAudit.droppedCalls===0);
    // Legacy/evicted detail may overlap runtime starts. Never add two counters blindly.
    const transportKnownTotal=knownTotal===null||runtimeOnly.length>0&&!completeStoredDetails?null:knownTotal+runtimeOnly.length;
    const findings=[];
    const journalReasons=persistedCalls.map(call=>call.reason);
    const has=(reason)=>journalReasons.includes(reason)||modelStarts.some(event=>event.details?.callReason===reason);
    if(has('transport_retry')||modelStarts.some(event=>event.details?.retryKind==='compatibility'))findings.push({code:'TRANSPORT_RETRY_OBSERVED',meaning:'存在连接重试或兼容路由重发'});
    if(has('format_repair'))findings.push({code:'FORMAT_REPAIR_OBSERVED',meaning:'布局格式或引用问题触发了完整回复纠错'});
    if(has('evidence_repair'))findings.push({code:'EVIDENCE_REPAIR_OBSERVED',meaning:'空间依据提取失败后重新提取'});
    if(has('missing_map_reply'))findings.push({code:'MAP_SUPPLEMENT_OBSERVED',meaning:'部分地图未返回布局，进行了补交'});
    if(has('batch_split'))findings.push({code:'BATCH_SPLIT_OBSERVED',meaning:'合批失败后缩小批量补交'});
    if(has('background_resume'))findings.push({code:'BACKGROUND_RESUME_OBSERVED',meaning:'继续处理原轮未完成的后台人物或事件结算'});
    const truncated=persistedCalls.some(call=>call.finishReason==='length')||events.some(event=>event.details?.finishReason==='length');
    if(truncated)findings.push({code:'OUTPUT_TRUNCATED',meaning:'观察到输出被截断；需要结合后续补交与纠错查看'});
    const started=events.filter(event=>event.code==='TURN_STARTED');
    if(started.length>1)findings.push({code:'MULTIPLE_TURN_STARTS',meaning:'同一楼层出现多次处理入口；需检查事件来源、重新生成和显式重试，尚不能据此认定重复发送'});
    const dropped=storedTurns.reduce((sum,turn)=>sum+(turn.requestAudit?.droppedCalls??0),0);
    /**
     * P14 §20.2/§20.3：楼层归属、业务轮判定、长度三口径、分段耗时、建图关联。
     * 这些都是视图已经算好的事实，导出只搬运；缺字段就写 null/省略，不补 0。
     */
    const first=storedTurns[0]??null;
    return {...group,calls:[...persistedCalls.map(call=>({...call,source:'stored-transport'})),...runtimeOnly],
      floorRef:first?.floorRef??null,
      countsAsBusinessTurn:storedTurns.length?storedTurns.some(turn=>turn.countsAsBusinessTurn===true):null,
      ...(storedTurns.length&&!storedTurns.some(turn=>turn.countsAsBusinessTurn===true)
        ?{countExclusionReason:first?.countExclusionReason??'no-transport-evidence'}:{}),
      lengths:first?.lengths??{rawResponseChars:null,visibleTextChars:null,reasoningTextChars:null},
      timing:first?.timing??null,
      transport:first?.transport??null,
      buildLinkage:first?.buildLinkage??null,
      reasons:storedTurns.flatMap(turn=>turn.reasons??[]).slice(0,64),
      counts:{recordedModelTransports:knownTotal,observedRuntimeStarts:starts.size,runtimeOnlyStarts:runtimeOnly.length,
        combinedModelTransports:transportKnownTotal,countComplete:transportKnownTotal!==null,
        observedLowerBound:Math.max(knownTotal??0,starts.size),callDetailsComplete:completeStoredDetails,
        logicalAttemptRecords:storedTurns.reduce((sum,turn)=>sum+(turn.attempts?.length??0),0),
        localApiEvents:events.filter(event=>event.code?.startsWith('API_CALL_')).length},
      findings,coverage:{storedTurns:storedTurns.length,storedCallDetailsDropped:dropped,hasLegacyTurns:storedTurns.some(turn=>!turn.requestAudit),
        runtimeLogHistory:'bounded-session-history-not-full-history'}};
  });
  /** P14 §20.2：分页投影合并。全部分页都确定才给数字，否则 null + 下界。 */
  const storedRows=[...new Map(turns.map((turn,index)=>[turn.id??`row:${index}`,turn])).values()];
  const aggregate=rows=>{
    const keys=new Set();let missing=0,dropped=0,unkeyed=0,known=0;
    for(const row of rows){
      const audit=row.countSource==='transport-journal'?row.requestAudit:null;
      if(!audit){missing++;known=Math.max(known,row.recordedModelTransports??0);continue;}
      dropped+=audit.droppedCalls??0;
      for(const call of audit.calls??[]){if(call.requestRef&&Number.isSafeInteger(call.transportAttempt)&&call.transportAttempt>0)keys.add(`${call.requestRef}#${call.transportAttempt}`);else unkeyed++;}
    }
    return {transports:missing||unkeyed?null:keys.size+dropped,transportsLowerBound:Math.max(keys.size+dropped,known),turnsWithoutCompleteLedger:missing};
  };
  const groupStored=(keyOf,fields)=>{
    const buckets=new Map();for(const row of storedRows){const key=keyOf(row);if(key===null)continue;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(row);}
    return [...buckets.values()].map(rows=>({...fields(rows[0]),turns:rows.length,...aggregate(rows)}));
  };
  const projectionTotals=(()=>{
    if(!pages.length)return null;
    const everyPageDetermined=pages.every(page=>page.transport&&page.transport.transports!==null);
    const lowerBound=pages.reduce((sum,page)=>sum+(Number.isFinite(page.transport?.transportsLowerBound)?page.transport.transportsLowerBound:0),0);
    const transports=everyPageDetermined?pages.reduce((sum,page)=>sum+page.transport.transports,0):null;
    const turnsWithoutCompleteLedger=pages.reduce((sum,page)=>sum+(Number.isFinite(page.transport?.turnsWithoutCompleteLedger)?page.transport.turnsWithoutCompleteLedger:0),0);
    const fromRows=storedRows.length>0&&storedRows.every(row=>typeof row.countSource==='string');
    return {
      pages:pages.length,
      scope:pages.length>1?'all-pages':(pages[0].scope??'page'),
      ...(fromRows?aggregate(storedRows):{transports,transportsLowerBound:lowerBound,turnsWithoutCompleteLedger}),
      /* 两个栏位天生重叠（同一批传输既属于楼层也属于窗口），导出里明确禁止相加。 */
      floorAndWindowTotalsAreIndependent:false,
      businessTurns:pages.reduce((sum,page)=>sum+(Number.isFinite(page.businessTurns)?page.businessTurns:0),0),
      excludedTurns:pages.reduce((sum,page)=>sum+(Number.isFinite(page.excludedTurns)?page.excludedTurns:0),0),
      byFloor:fromRows?groupStored(row=>row.floorRef??'unknown-floor',row=>({floorRef:row.floorRef??'unknown-floor'})):pages.flatMap(page=>page.groups?.byFloor??[]),
      byWindow:fromRows?groupStored(row=>Number.isSafeInteger(row.buildLinkage?.windowSequence)?JSON.stringify([row.buildLinkage.jobRef,row.buildLinkage.windowSequence]):null,row=>({jobRef:row.buildLinkage.jobRef,windowSequence:row.buildLinkage.windowSequence})):pages.flatMap(page=>page.groups?.byWindow??[]),
      jobWindows:[...new Map(pages.flatMap(page=>page.jobWindows??[]).map(job=>[job.jobRef,job])).values()],
      windowLinkage:pages[pages.length-1]?.windowLinkage??'no-build-job-recorded',
    };
  })();
  return {
    schema:'atlas-turn-analysis/v1',exportedAt,pluginVersion,build,scope,
    explanation:{counts:'每个 MODEL_REQUEST_STARTED 表示一次模型传输；headers/completed/failed 是该次传输的后续事件，不能相加。',
      attempts:'数据库 attempts 是逻辑尝试记录，可能包含兼容重发或多个阶段；条数不等于真实发送次数。',
      status:'调用 completed 只表示模型传输完成；地图与业务结果见 storedTurns 中的状态、变更和问题。',
      lengths:'rawResponseChars 是原始传输长度（含 JSON/SSE 包装）；visibleTextChars 是助手可见正文；reasoningTextChars 只在响应存在明确推理字段时才有值，否则为 null——不从原始与可见的差值推断推理长度。',
      timing:'headersMs 是观测到响应头的时间，bodyMs 是正文接收时长；logicalDurationMs 若覆盖了兼容重发（durationIncludesCompatibilityRetry=true）则单列，不能当作单次请求耗时累加。没有首 token / 供应商排队数据即视为未知。',
      totals:'楼层合计与窗口合计回答的是不同问题、且天生重叠；请只看 projection.transports（或下界），不要相加两栏。',
      missing:'null 表示未知，0 表示确认没有。旧轮次缺账本时给 null 并给出有证据下界，不伪造 0。',
      coverage:'旧轮次缺失的请求明细无法追溯恢复。旧版本正常运行日志可能因刷新丢失；新版本保留有限的会话调用历史；新版本逐轮传输账本随存档保存。'},
    projection:projectionTotals,
    coverage:{storedTurnsExported:turns.length,totalStoredTurns:totalTurns,storedTurnPagesComplete:turns.length===totalTurns,
      runtimeEvents:events.length,excludedOtherOrUnscopedEvents:diagnostics.length-events.length,runtimeRetention:'bounded-session-history',
      retainedCallEvents:Number.isSafeInteger(runtimeCoverage.retainedCallEvents)?runtimeCoverage.retainedCallEvents:null,
      droppedCallEvents:Number.isSafeInteger(runtimeCoverage.droppedCallEvents)?runtimeCoverage.droppedCallEvents:null,
      sessionPersistenceAvailable:runtimeCoverage.sessionPersistenceAvailable===true,
      unknownCountRounds:rounds.filter(round=>!round.counts.countComplete).length},
    rounds,unassignedEvents:events.filter(event=>!event.details?.turnRef),
  };
}
