// Both MCP wake and the Google Doc use this exact rendering.
export function wakeView(store, args = {}, compactor) {
  return store.wake({...args, allowPending:compactor?.available === true});
}
export function completeWakeView(store, compactor) {
  const snapshot=store.count(), pages=[];
  for(let part=1;;part++){
    let page;
    try {page=wakeView(store,{part,snapshot},compactor);}
    catch(error){return error.message;}
    pages.push(page);
    if(page.endsWith('You are awake.'))return pages.join('\n\n');
  }
}
