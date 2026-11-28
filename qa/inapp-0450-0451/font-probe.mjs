import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';

// EdgeDriver forwards the request to the webview already attached to this session.
// CSS.getPlatformFontsForNode reports glyphs actually used rather than a CSS fallback list.
export async function fontProbe(browser, port, selector, expected) {
  const element = await browser.$(selector);
  await element.waitForDisplayed({timeout:8000});
  const text = await browser.execute(node => {
    node.scrollIntoView({block:'center',behavior:'instant'});
    node.setAttribute('data-kazna-font-witness','true');
    return node.textContent.trim();
  }, element);
  await sleep(160);
  const cdp = async (cmd, params = {}) => {
    const response=await fetch('http://127.0.0.1:'+port+'/session/'+browser.sessionId+'/ms/cdp/execute',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd,params}),signal:AbortSignal.timeout(10000)
    });
    const {value}=await response.json();
    assert(response.ok && value && !value.error,cmd+' '+JSON.stringify(value));
    return value;
  };
  try {
    await cdp('DOM.enable');await cdp('CSS.enable');
    const {root}=await cdp('DOM.getDocument',{depth:0});
    const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:'[data-kazna-font-witness]'});
    assert(nodeId,'Нет узла шрифта '+selector);
    const {fonts}=await cdp('CSS.getPlatformFontsForNode',{nodeId});
    const actual=fonts.filter(f=>f.glyphCount>0);
    assert(actual.some(f=>expected.test(f.familyName+' '+f.postScriptName)),selector+' '+JSON.stringify(actual));
    return {selector,text,actual};
  } finally {
    await browser.execute(node=>node.removeAttribute('data-kazna-font-witness'),element);
  }
}
