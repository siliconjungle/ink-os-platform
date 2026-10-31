export async function responseJSON(response){
 const text=await response.text();let result;
 if(text.trim()){try{result=JSON.parse(text);}catch{throw Object.assign(Error(response.ok?'The server returned an invalid response. Please try again.':'The request failed (HTTP '+response.status+'). Please try again.'),{status:response.status});}}
 if(!response.ok)throw Object.assign(Error(result?.error||(response.status===413?'The file is too large. Keep each file below 24 MiB.':'The request failed (HTTP '+response.status+'). Please try again.')),{status:response.status,current:result?.current});
 if(!text.trim()&&response.status!==204&&response.status!==205)throw Object.assign(Error('The server returned an empty response. Please try again.'),{status:response.status});
 return result;
}
