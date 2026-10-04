/** Map interaction ownership: cameras, navigation, gestures, resize and teardown. */
export function createMapController(math) {
 const cameras=new Map(),viewports=new Map(),cleanups=[];
 let disposed=false,stack=[];
 function listen(target,type,handler,options){
  target.addEventListener(type,handler,options);
  cleanups.push(()=>target.removeEventListener(type,handler,options));
 }
 function observe(viewport,onResize){
  if(typeof ResizeObserver!=="function")return;
  let timer=null,w=0,h=0;
  const observer=new ResizeObserver(entries=>{
   const rect=entries[0]?.contentRect;if(!rect||disposed)return;
   const nextW=Math.round(rect.width),nextH=Math.round(rect.height);
   if(nextW===w&&nextH===h)return;w=nextW;h=nextH;
   if(timer)clearTimeout(timer);
   timer=setTimeout(()=>{timer=null;if(!disposed)onResize();},120);
  });
  observer.observe(viewport);
  cleanups.push(()=>{observer.disconnect();if(timer)clearTimeout(timer);});
 }
 function mountViewport(ports){
  const {viewport,readCamera,commitCamera,areaDraw,areaDrawCellAt,renderAreaDraw,closeMapPanel}=ports;
  const {createPanGesture,createPinchTracker,zoomCameraAtPoint,panCameraBy}=math;
    const panGesture = createPanGesture();
    const pinch = createPinchTracker();
    const activePointers = new Map();
    const GESTURE_BLOCK_SELECTOR =
      "button, input, select, textarea, label, .aw-mappanel, .aw-maptools, .aw-scale, .aw-mapcrumb, .aw-maplegend, .aw-travel, .aw-zoom";
    listen(viewport, "pointerdown", (e) => {
      const camera = readCamera();
      if (!camera) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const interactive = Boolean(e.target?.closest?.(GESTURE_BLOCK_SELECTOR));
      /**
       * H15b：绘制模式**独占**网格点击——不启动平移，把这一下当成「选中/取消一个格」。
       * 工具栏 / 弹层等交互元素仍然照常可点（interactive 优先）。
       */
      if (areaDraw.active && !interactive) {
        const cell = areaDrawCellAt(e.clientX, e.clientY);
        if (cell) {
          const key = `${cell.x},${cell.y}`;
          if (areaDraw.cells.has(key)) areaDraw.cells.delete(key); else areaDraw.cells.add(key);
          renderAreaDraw();
        }
        return;
      }
      if (interactive) return;
      pinch.down(e.pointerId, e.clientX, e.clientY);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size >= 2) {
        panGesture.cancel(); // 进入双指：终止单指平移
        viewport.setPointerCapture?.(e.pointerId);
        return;
      }
      panGesture.down(e.clientX, e.clientY);
      viewport.setPointerCapture?.(e.pointerId);
    });
    listen(viewport, "pointermove", (e) => {
      const camera = readCamera();
      if (!camera) return;
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.active) {
        const update = pinch.move(e.pointerId, e.clientX, e.clientY);
        if (update) {
          const rect = viewport.getBoundingClientRect();
          commitCamera(zoomCameraAtPoint(camera, update.x - rect.left, update.y - rect.top, viewport.clientWidth || 0, viewport.clientHeight || 0, update.factor));
        }
        return;
      }
      const step = panGesture.move(e.clientX, e.clientY);
      if (step?.panning) commitCamera(panCameraBy(camera, step.dx, step.dy));
    });
    const endMapPointer = (e, cancelled) => {
      if (activePointers.has(e.pointerId)) {
        activePointers.delete(e.pointerId);
        if (cancelled) pinch.cancel();
        else pinch.up(e.pointerId);
      }
      if (pinch.active) return;
      if (activePointers.size === 1) {
        // 双指回落到单指：以剩余指位重启平移基线
        const [only] = [...activePointers.values()];
        panGesture.cancel();
        panGesture.down(only.x, only.y);
        return;
      }
      if (cancelled) panGesture.cancel();
      else panGesture.up(); // suppress 标记保留给 click 消费（不在 pointerup 提前清除）
    };
    listen(viewport, "pointerup", (e) => endMapPointer(e, false));
    listen(viewport, "pointercancel", (e) => endMapPointer(e, true));
    // 光标缩放：光标下世界点不漂移（zoomCameraAtPoint）；ctrl+滚轮 = 触控板捏合细步
    listen(viewport, "wheel", (e) => {
      const camera = readCamera();
      if (!camera) return;
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const factor = e.ctrlKey
        ? Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * 0.01)))
        : e.deltaY < 0 ? 1.2 : 1 / 1.2;
      commitCamera(zoomCameraAtPoint(camera, e.clientX - rect.left, e.clientY - rect.top, viewport.clientWidth || 0, viewport.clientHeight || 0, factor));
    }, { passive: false });
    // 0.9.47 mapview 同款交互：点地图空白处 / 按 ESC 关面板；面板内点击不冒泡
    listen(viewport, "click", () => {
      if (panGesture.consumeClick()) return; // pan 结束的合成 click 不当空白点击
      closeMapPanel();
    });

  cleanups.push(()=>{
   for(const id of activePointers.keys())try{viewport.releasePointerCapture?.(id);}catch{}
   activePointers.clear();panGesture.cancel();pinch.cancel();
  });
 }
 function dispose(){
  if(disposed)return;disposed=true;
  for(const cleanup of cleanups.splice(0).reverse())cleanup();
  cameras.clear();viewports.clear();stack=[];
 }
 return {cameras,viewports,observe,mountViewport,dispose,listen,
  get stack(){return stack;},set stack(value){stack=value;}};
}
export function markerPopupPosition(viewport,marker,width=280,height=240){
 let left=marker.right-viewport.left+10;
 if(left+width>viewport.width-10)left=marker.left-viewport.left-width-10;
 if(left<10)left=Math.max(10,(viewport.width-width)/2);
 let top=Math.min(Math.max(8,marker.top-viewport.top),Math.max(8,viewport.height-height-10));
 return {left:Math.round(left),top:Math.round(top)};
}
