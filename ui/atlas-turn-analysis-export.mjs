/** Join stored turn summaries with the available safe transport/host diagnostics. */
export function buildTurnAnalysisExport({turns=[],diagnostics=[],scope={},pluginVersion=null,build=null,exportedAt=new Date().toISOString(),totalTurns=turns.length,runtimeCoverage={}}={}) {
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
    return {...group,calls:[...persistedCalls.map(call=>({...call,source:'stored-transport'})),...runtimeOnly],
      counts:{recordedModelTransports:knownTotal,observedRuntimeStarts:starts.size,runtimeOnlyStarts:runtimeOnly.length,
        combinedModelTransports:transportKnownTotal,countComplete:transportKnownTotal!==null,
        observedLowerBound:Math.max(knownTotal??0,starts.size),callDetailsComplete:completeStoredDetails,
        logicalAttemptRecords:storedTurns.reduce((sum,turn)=>sum+(turn.attempts?.length??0),0),
        localApiEvents:events.filter(event=>event.code?.startsWith('API_CALL_')).length},
      findings,coverage:{storedTurns:storedTurns.length,storedCallDetailsDropped:dropped,hasLegacyTurns:storedTurns.some(turn=>!turn.requestAudit),
        runtimeLogHistory:'bounded-session-history-not-full-history'}};
  });
  return {
    schema:'atlas-turn-analysis/v1',exportedAt,pluginVersion,build,scope,
    explanation:{counts:'每个 MODEL_REQUEST_STARTED 表示一次模型传输；headers/completed/failed 是该次传输的后续事件，不能相加。',
      attempts:'数据库 attempts 是逻辑尝试记录，可能包含兼容重发或多个阶段；条数不等于真实发送次数。',
      status:'调用 completed 只表示模型传输完成；地图与业务结果见 storedTurns 中的状态、变更和问题。',
      coverage:'旧轮次缺失的请求明细无法追溯恢复。旧版本正常运行日志可能因刷新丢失；新版本保留有限的会话调用历史；新版本逐轮传输账本随存档保存。'},
    coverage:{storedTurnsExported:turns.length,totalStoredTurns:totalTurns,storedTurnPagesComplete:turns.length===totalTurns,
      runtimeEvents:events.length,excludedOtherOrUnscopedEvents:diagnostics.length-events.length,runtimeRetention:'bounded-session-history',
      retainedCallEvents:Number.isSafeInteger(runtimeCoverage.retainedCallEvents)?runtimeCoverage.retainedCallEvents:null,
      droppedCallEvents:Number.isSafeInteger(runtimeCoverage.droppedCallEvents)?runtimeCoverage.droppedCallEvents:null,
      sessionPersistenceAvailable:runtimeCoverage.sessionPersistenceAvailable===true,
      unknownCountRounds:rounds.filter(round=>!round.counts.countComplete).length},
    rounds,unassignedEvents:events.filter(event=>!event.details?.turnRef),
  };
}
