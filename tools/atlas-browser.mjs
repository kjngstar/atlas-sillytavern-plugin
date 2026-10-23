import {chromium} from 'playwright';

/** Optional browser/runtime overrides keep verification usable in constrained hosts. */
export async function launchAtlasBrowser(){
 let executablePath=process.env.ATLAS_CHROME_PATH,args=[],single=process.env.ATLAS_BROWSER_SINGLE_PROCESS==='1';
 if(process.env.ATLAS_BROWSER_RUNTIME_MODULE){const {default:runtime}=await import(process.env.ATLAS_BROWSER_RUNTIME_MODULE);executablePath=await runtime.executablePath();args=runtime.args;single=true;}
 if(single)args=[...new Set([...args,'--single-process','--no-zygote','--disable-gpu','--no-sandbox','--disable-dev-shm-usage'])];
 const browser=await chromium.launch({headless:true,...executablePath?{executablePath}:{},args});
 if(single){
  let context=null;browser.newPage=async(options={})=>{
   if(!context)context=await browser.newContext(options);const page=await context.newPage();
   if(options.viewport)await page.setViewportSize(options.viewport);
   if(options.deviceScaleFactor&&options.viewport){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{...options.viewport,deviceScaleFactor:options.deviceScaleFactor,mobile:false});page.once('close',()=>{void cdp.detach().catch(()=>{});});}
   return page;
  };
 }
 return browser;
}
