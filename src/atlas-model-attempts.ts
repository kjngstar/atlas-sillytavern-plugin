/** Record model batches without retaining prompts, replies or credentials. */
import { sha256HexSync } from './atlas-db-envelope.ts';
import type { AtlasModelPort } from './atlas-db-contract.ts';

export function logModelAttempts(port: AtlasModelPort, now: () => number, record: (entry: Record<string, unknown>) => void): AtlasModelPort {
  return { request: async request => {
    const started=now();
    const common={kind:request.phase,phase:request.phase,batch_id:request.batchId,started_wall_ms:started,
      input_chars:request.messages.reduce((sum,message)=>sum+message.content.length,0),
      ...(request.batchTargets?{target_kind:request.batchTargets.kind,target_count:request.batchTargets.count,estimated_output_tokens:request.batchTargets.estimatedOutputTokens}:{})};
    try {
      const response=await port.request(request);
      record({...common,finished_wall_ms:now(),http_status:response.httpStatus,response_chars:response.text?.length??0,
        response_hash:sha256HexSync(response.text??''),finish_reason:response.finishReason});
      return response;
    } catch(error) {
      const code=(error as {code?:string}).code;
      if(code!=='MODEL_BUDGET_EXHAUSTED'&&code!=='MODEL_BATCH_DUPLICATE')record({...common,finished_wall_ms:now(),error_code:code,error:(error as Error).message});
      throw error;
    }
  }};
}
