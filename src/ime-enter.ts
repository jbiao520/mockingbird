// macOS CJK IMEs confirm a candidate with Enter. That key arrives as a keydown
// whose isComposing is already false, sometimes after compositionend, and
// sometimes with legacy keyCode 229. Hold the composition guard until the next
// turn so the confirming Enter cannot submit the AI prompt.
export function createImeEnterGuard(){
  let composing=false;
  let release:ReturnType<typeof setTimeout>|undefined;
  const stopRelease=()=>{if(release!==undefined){clearTimeout(release);release=undefined;}};
  return {
    compositionStart(){stopRelease();composing=true;},
    compositionEnd(){stopRelease();release=setTimeout(()=>{release=undefined;composing=false;},0);},
    blur(){stopRelease();composing=false;},
    keydown(event:{key:string;shiftKey?:boolean;isComposing?:boolean;keyCode?:number}):'send'|'ignore'|'swallow'{
      if(event.key!=='Enter'||event.shiftKey)return 'ignore';
      if(event.isComposing||event.keyCode===229)return 'ignore';
      if(composing)return 'swallow';
      return 'send';
    },
  };
}
