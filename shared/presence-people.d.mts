export function presencePeople<T extends{id:string;accountId?:string}>(peers:T[],self?:string):T[];
