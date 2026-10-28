/** Bounded Move type grammar. Type arguments never choose a callable Move target. */
export function canonicalCoinType(value:string):string{
    if(typeof value!=="string"||value.length>512||!/^[\x00-\x7f]*$/.test(value))throw new TypeError("Invalid coin type");
    let offset=0;
    const space=()=>{while(/\s/.test(value[offset]??"")&&offset<value.length)offset++;};
    function token(pattern:RegExp){space();const match=pattern.exec(value.slice(offset));if(!match)throw new TypeError("Invalid coin type");offset+=match[0].length;return match[0];}
    function type(depth:number):string{
        if(depth>8)throw new TypeError("Coin type nesting exceeds the limit");space();
        const primitive=/^(bool|u8|u16|u32|u64|u128|u256|address)\b/.exec(value.slice(offset));
        if(primitive){offset+=primitive[0].length;return primitive[0];}
        if(value.slice(offset).startsWith("vector")){token(/^vector\s*</);const inner=type(depth+1);token(/^>/);return `vector<${inner}>`;}
        const address=token(/^0x[0-9a-fA-F]{1,64}/);token(/^::/);const module=token(/^[A-Za-z_][A-Za-z0-9_]*/);token(/^::/);const name=token(/^[A-Za-z_][A-Za-z0-9_]*/);
        let result=`0x${address.slice(2).toLowerCase().padStart(64,"0")}::${module}::${name}`;space();
        if(value[offset]==="<"){
            offset++;const parameters=[type(depth+1)];space();
            while(value[offset]===","){offset++;parameters.push(type(depth+1));if(parameters.length>16)throw new TypeError("Too many coin type arguments");space();}
            token(/^>/);result+=`<${parameters.join(",")}>`;
        }
        return result;
    }
    const parsed=type(0);space();if(offset!==value.length||!parsed.startsWith("0x"))throw new TypeError("Coin type must be a complete Move struct tag");return parsed;
}
