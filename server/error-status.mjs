/** Transport failures are retryable; preserve explicit validation/auth errors. */
export function errorStatus(error){
 if(Number.isInteger(error?.status)&&error.status>=400&&error.status<=599)return error.status;
 for(let cause=error,depth=0;cause&&depth<5;cause=cause.cause,depth++){
  if(['TimeoutError','AbortError'].includes(cause.name)||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(cause.code))return 504;
  if(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET'].includes(cause.code))return 503;
 }
 return 400;
}
