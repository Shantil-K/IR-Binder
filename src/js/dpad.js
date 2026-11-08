// Remote control (D-pad) navigation, the same way OpenLauncher does it.
// Arrow keys move a focus ring (.dfocus) to the nearest item in that direction, OK clicks it, Back goes up a level.
// Focus is a class, not DOM focus, except in text boxes: OK on one focuses it so the on-screen keyboard opens,
// and while typing the keys belong to the text box until Back.
// Moving the Magic Remote's pointer hides the ring; when the pointer times out, the item under it gets the ring.

const KEY_LEFT=37;
const KEY_UP=38;
const KEY_RIGHT=39;
const KEY_DOWN=40;
const KEY_ENTER=13;
const KEY_BACK=461;
const KEY_ESC=27;
const MOUSE_SWITCH_PX=10;     // pointer jitter smaller than this doesn't leave keyboard mode
const EDGE_TOLERANCE=2;

let dpadfocus=null;
let keyboardmode=true;        // a TV app starts in remote mode
let keylockuntil=0;           // main.js locks the keys while learning a signal
let keylocked=false;
let hoveredel=null;
let mousex=0;
let mousey=0;
let anchorx=0;
let anchory=0;

// What the arrows can reach right now (set by main.js), and what Back does.
let dpadcontext=() => [];
let dpadback=() => {};

// ---- choosing the neighbour: only items beyond the current one's edge count, and items in line beat closer ones off to the side
function pickneighbor(from,candidates,key) {
	const fx=from.left+from.width/2;
	const fy=from.top+from.height/2;
	let best=-1;
	let bestscore=Infinity;
	candidates.forEach((rect,index) => {
		const dx=rect.left+rect.width/2-fx;
		const dy=rect.top+rect.height/2-fy;
		let beyond,along,across;
		if(key===KEY_RIGHT){ beyond=rect.left>=from.left+from.width-EDGE_TOLERANCE; along=dx; across=dy; }
		else if(key===KEY_LEFT){ beyond=rect.left+rect.width<=from.left+EDGE_TOLERANCE; along=-dx; across=dy; }
		else if(key===KEY_DOWN){ beyond=rect.top>=from.top+from.height-EDGE_TOLERANCE; along=dy; across=dx; }
		else { beyond=rect.top+rect.height<=from.top+EDGE_TOLERANCE; along=-dy; across=dx; }
		if(!beyond || along<=0){ return; }
		const score=along+Math.abs(across)*2.5;
		if(score<bestscore){ bestscore=score; best=index; }
	});
	return best;
}

function isvisible(node) {
	return node.getClientRects().length>0 && !node.disabled;
}

function within(root,selector) {
	return Array.prototype.slice.call(root.querySelectorAll(selector)).filter(isvisible);
}

// Scroll a list by hand so the focused item shows (cheaper and steadier than scrollIntoView on the TV).
function reveal(node) {
	for(let box=node.parentElement;box && box!==document.body;box=box.parentElement){
		if(box.scrollHeight<=box.clientHeight){ continue; }
		const outer=box.getBoundingClientRect();
		const rect=node.getBoundingClientRect();
		const margin=outer.height*0.05;
		if(rect.top<outer.top+margin){ box.scrollTop-=outer.top+margin-rect.top; }
		else if(rect.bottom>outer.bottom-margin){ box.scrollTop+=rect.bottom-(outer.bottom-margin); }
		return;
	}
}

function setfocus(node) {
	if(dpadfocus===node){ return; }
	if(dpadfocus){ dpadfocus.classList.remove("dfocus"); }
	dpadfocus=node;
	if(node && keyboardmode){
		node.classList.add("dfocus");
		reveal(node);
	}
}

function clearfocus() {
	if(dpadfocus){ dpadfocus.classList.remove("dfocus"); }
	keyboardmode=false;
}

// After the screen changed (a dialog opened or a list was rebuilt): if the ring's item is gone, put it on `fallback`
// or the first item of what is showing now.
function settle(fallback) {
	const list=dpadcontext();
	if(dpadfocus && list.indexOf(dpadfocus)!==-1){ return; }
	setfocus(fallback && list.indexOf(fallback)!==-1?fallback:list[0] || null);
}

function lockkeys(on,graceMs) {
	keylocked=on;
	if(!on && graceMs){ keylockuntil=Date.now()+graceMs; }
}

function istyping() {
	const node=document.activeElement;
	return !!node && (node.tagName==="TEXTAREA" || node.tagName==="INPUT");
}

function activate(node) {
	if(node.tagName==="INPUT"){ node.focus(); }
	else { node.click(); }
}

function onkey(event) {
	const code=event.keyCode;
	// While learning, the press is meant for the daemon, not this screen.
	if(keylocked || Date.now()<keylockuntil){
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	if(code===KEY_BACK || code===KEY_ESC){
		event.preventDefault();
		if(istyping()){ document.activeElement.blur(); }
		else { dpadback(); }
		return;
	}
	if(code!==KEY_LEFT && code!==KEY_UP && code!==KEY_RIGHT && code!==KEY_DOWN && code!==KEY_ENTER){ return; }
	if(istyping()){ return; }
	event.preventDefault();
	const entering=!keyboardmode;
	keyboardmode=true;
	anchorx=mousex;
	anchory=mousey;
	const list=dpadcontext();
	if(list.length===0){ return; }
	if(!dpadfocus || list.indexOf(dpadfocus)===-1){
		// nothing focused: this press only shows the ring, on the item under the pointer if there is one
		dpadfocus=null;
		setfocus(entering && hoveredel && list.indexOf(hoveredel)!==-1?hoveredel:list[0]);
		return;
	}
	if(entering){
		const node=dpadfocus;
		dpadfocus=null;
		setfocus(node);
		return;
	}
	if(code===KEY_ENTER){
		activate(dpadfocus);
		return;
	}
	const others=list.filter((each) => each!==dpadfocus);
	const index=pickneighbor(dpadfocus.getBoundingClientRect(),others.map((each) => each.getBoundingClientRect()),code);
	if(index!==-1){ setfocus(others[index]); }
}

function onmouse(event) {
	mousex=event.clientX;
	mousey=event.clientY;
	if(keyboardmode && Math.abs(mousex-anchorx)+Math.abs(mousey-anchory)>MOUSE_SWITCH_PX){ clearfocus(); }
}

function onmouseover(event) {
	const list=dpadcontext();
	hoveredel=null;
	for(let node=event.target;node;node=node.parentNode){
		if(list.indexOf(node)!==-1){ hoveredel=node; return; }
	}
}

// The Magic Remote's pointer timed out: the item under it keeps the ring, and the arrows carry on from it.
function oncursorstate(event) {
	if(!event.detail || event.detail.visibility!==false || istyping()){ return; }
	if(!hoveredel || dpadcontext().indexOf(hoveredel)===-1){ return; }
	keyboardmode=true;
	anchorx=mousex;
	anchory=mousey;
	dpadfocus=null;
	setfocus(hoveredel);
}

function initdpad() {
	window.addEventListener("keydown",onkey,true);
	window.addEventListener("mousemove",onmouse,true);
	window.addEventListener("mouseover",onmouseover,true);
	window.addEventListener("mousedown",() => { if(keyboardmode){ clearfocus(); } },true);
	document.addEventListener("cursorStateChange",oncursorstate);
}

initdpad();
