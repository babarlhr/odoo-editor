"use strict";

import {sanitize} from "./sanitize.js";
import {commonParentGet, hasContentAfter} from "./utils/utils.js";
import {nodeToObject, objectToNode} from "./utils/serialize.js";
import {parentBlock, setTagName, setCursor} from "./dom/dom.js";

function callAnchor(method) {
    let sel = document.defaultView.getSelection();
    if (sel.anchorNode.nodeType==Node.TEXT_NODE)
        return sel.anchorNode[method](sel.anchorOffset);

    let node = sel.anchorNode;
    if (sel.anchorOffset)
        node = sel.anchorNode.childNodes[sel.anchorOffset-1]
    return node[method]((node.nodeType==Node.TEXT_NODE)?node.length:0);
}

export class Editor {
    constructor(dom) {
        this.dom = sanitize(dom);
        this.history = [{
            cursor: {
                anchorNode: undefined,
                anchorOffset: undefined,
                focusNode: undefined,
                focusOffset: undefined,
            },
            dom: [],
            id: undefined
        }];

        this.vdom = dom.cloneNode(true);
        this.idSet(dom, this.vdom);

        dom.setAttribute("contentEditable", true);
        this.observerActive(['characterData']);
        this.dom.addEventListener('keydown', this.keyDown.bind(this));
        document.onselectionchange = this.selectionChange.bind(this);
        this.toolbar = document.querySelector('#toolbar');
        this.toolbar.querySelectorAll('div.btn').forEach((item) => {
            item.onmousedown = this.toolbarClick.bind(this);
        });
        this.collaborate = true;
        this.collaborate_last = null;
    }

    sanitize() {
        // find common ancestror in this.history[-1]
        let step = this.history[this.history.length-1];
        let ca, record;
        for (record of step.dom) {
            let node = this.idFind(this.dom, record.parentId || record.id) || this.dom;
            ca = ca?commonParentGet(ca, node, this.dom):node;
        }
        if (! ca) return false;
        console.log('sanitizing');

        // sanitize and mark current position as sanitized
        sanitize(ca);
    }

    //
    // VDOM Processing
    //
    idSet(src, dest) {
        if (src.oid) {
            dest.oid = src.oid;
        } else {
            // TODO: use a real UUID4 generator
            src.oid = dest.oid = Math.random()*2**31 | 0;
        }
        let childsrc = src.firstChild;
        let childdest = dest.firstChild;
        while (childsrc) {
            this.idSet(childsrc, childdest);
            childsrc = childsrc.nextSibling;
            childdest = childdest.nextSibling;
        }
    }

    // TODO: improve to avoid traversing the whole DOM just to find a node of an ID
    idFind(dom, id, parentid) {
        if (dom.oid==id && ((!parentid) || dom.parentNode.oid==parentid))
            return dom;
        let cur = dom.firstChild;
        while (cur) {
            if (dom.oid==id && ((!parentid) || dom.parentNode.oid==parentid))
                return dom;
            let result = this.idFind(cur, id, parentid);
            if (result)
                return result;
            cur = cur.nextSibling;
        }
    }


    // Observer that syncs doms

    // if not in collaboration mode, no need to serialize / unserialize
    serialize(node) {
        if (this.collaborate)
            return nodeToObject(node);
        return node;
    }
    unserialize(obj) {
        return this.collaborate?objectToNode(obj):obj;
    }

    observerUnactive() {
        this.observer.disconnect();
        this.observerFlush();
    }
    observerFlush() {
        let records = this.observer.takeRecords();
        this.observerApply(this.dom, this.vdom, records);
    }
    observerActive(mode) {
        this.observer = new MutationObserver(records => {
            this.observerApply(this.dom, this.vdom, records);
        });
        this.observer.observe(this.dom, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
            characterDataOldValue: true,
        });
    }

    observerApply(srcel, destel, records) {
        for (let record of records) {
            switch (record.type) {
                case "characterData":
                    let node = this.idFind(destel, record.target.oid)
                    if (node) {
                        console.log('char ', node.textContent, '->', record.target.textContent);
                        this.history[this.history.length-1].dom.push({
                            'type': "characterData",
                            'id': record.target.oid,
                            "text": record.target.textContent,
                            "oldValue": node.textContent
                        });
                        node.textContent = record.target.textContent;
                    }
                    break
                case "childList":
                    record.removedNodes.forEach( (removed, index) => {
                        console.log('remove', removed);
                        this.history[this.history.length-1].dom.push({
                            'type': "remove",
                            'id': removed.oid,
                            'parentId': record.target.oid,
                            'node': this.serialize(removed),
                            'nextId': record.nextSibling ? record.nextSibling.oid : undefined,
                            'previousId': record.previousSibling ? record.previousSibling.oid : undefined,
                        });
                        let toremove = this.idFind(destel, removed.oid, record.target.oid);
                        if (toremove)
                            toremove.remove()
                    });
                    record.addedNodes.forEach( (added, index) => {
                        if (! record.target.oid) return false;
                        if (added.oid && this.idFind(destel, added.oid)) {
                            if (record.target.oid == this.idFind(destel, added.oid).parentNode.oid) {
                                return false;
                            }
                        }
                        let newnode = added.cloneNode(1);
                        let action = {
                            'type': "add",
                        }
                        if (! record.nextSibling) {
                            this.idFind(destel, record.target.oid).append(newnode);
                            action['append'] = record.target.oid;
                        } else if (record.nextSibling.oid) {
                            this.idFind(destel, record.nextSibling.oid).before(newnode);
                            action['before'] = record.nextSibling.oid;
                        } else if (record.previousSibling.oid) {
                            this.idFind(destel, record.previousSibling.oid).after(newnode);
                            action['after'] = record.previousSibling.oid;
                        } else
                            return false;
                        this.idSet(added, newnode);
                        action['id'] = added.oid;
                        action['node'] = this.serialize(newnode);
                        console.log('added', added);
                        this.history[this.history.length-1].dom.push(action);
                    });
                    break;
                default:
                    console.log('Unknown mutation type: '+record.type)
            }
        }
        if (srcel.innerHTML!=destel.innerHTML) {
            console.log('DOM & vDOM differs');
        }
    }


    // selection handling
    selectionChange(event) {
        let sel = document.defaultView.getSelection();
        if (sel.isCollapsed) {
            this.toolbar.style.visibility = 'hidden';
            return true;
        }
        this.toolbar.style.visibility = 'visible';
        this.toolbarUpdate();
    }

    toolbarUpdate() {
        let sel = document.defaultView.getSelection();
        this.toolbar.querySelector('#bold').classList.toggle('active', document.queryCommandState("bold"));
        this.toolbar.querySelector('#italic').classList.toggle('active', document.queryCommandState("italic"));
        this.toolbar.querySelector('#underline').classList.toggle('active', document.queryCommandState("underline"));
        this.toolbar.querySelector('#strikeThrough').classList.toggle('active', document.queryCommandState("strikeTrough"));

        let pnode = parentBlock(sel.anchorNode);
        this.toolbar.querySelector('#paragraph').classList.toggle('active', pnode.tagName=='P');
        this.toolbar.querySelector('#heading1').classList.toggle('active', pnode.tagName=='H1');
        this.toolbar.querySelector('#heading2').classList.toggle('active', pnode.tagName=='H2');
        this.toolbar.querySelector('#heading3').classList.toggle('active', pnode.tagName=='H3');
        this.toolbar.querySelector('#blockquote').classList.toggle('active', pnode.tagName=='BLOCKQUOTE');
        this.toolbar.querySelector('#unordered').classList.toggle('active', (pnode.tagName=='LI') && (pnode.parentElement.tagName=="UL"));
        this.toolbar.querySelector('#ordered').classList.toggle('active', (pnode.tagName=='LI') && (pnode.parentElement.tagName=="OL"));
        return true;
    }

    // toolbar handling
    toolbarClick(event) {
        const TAGS= {
            'paragraph': 'p',
            'heading1': 'H1',
            'heading2': 'H2',
            'heading3': 'H3',
            'blockquote': 'BLOCKQUOTE',
            'unordered': 'UL',
            'ordered': 'OL',
        }
        try {
            if (['bold', 'italic', 'underline', 'strikeThrough'].includes(event.toElement.id)) {
                document.execCommand(event.toElement.id);
            } else {
                let sel = document.defaultView.getSelection();
                let pnode = parentBlock(sel.anchorNode);
                setTagName(pnode, TAGS[event.toElement.id]);
            }
            this.toolbarUpdate();
        } catch(err) {
            if (err.message!='unbreakable') throw err;
            this.historyRollback();
        }
        event.preventDefault();
    }

    // keyboard handling
    keyDown(event) {
        console.log("Keyboard Event "+ event.keyCode);
        this.historyStep();

        let cb = () => {};
        let sel = document.defaultView.getSelection();
        try {
            if (event.keyCode === 13) {                                          // enter key
                event.preventDefault();
                if (! event.shiftKey) {
                    try {
                        callAnchor('oEnter');
                    } catch(err) {
                        if (err.message!='unbreakable') throw err;
                        this.historyRollback();
                        callAnchor('oShiftEnter');
                    }
                } else {
                    callAnchor('oShiftEnter');
                }
            }
            else if (event.keyCode === 8) {                                      // backspace
                event.preventDefault();
                callAnchor('oDeleteBackward');
            }
            else if (event.keyCode === 9 && event.shiftKey) {                    // tab key
                callAnchor('oShiftTab') && event.preventDefault();
            }
            else if (event.keyCode === 9 && !event.shiftKey) {                    // tab key
                callAnchor('oTab') && event.preventDefault();
            }
            else if (event.keyCode === 46) {                                     // delete
                event.preventDefault();
                alert('delete not implemented yet');
            } else if ((event.key == 'z') && event.ctrlKey) {                    // Ctrl Z: Undo
                event.preventDefault();
                this.historyUndo();
            }
            else if ((event.key == 'y') && event.ctrlKey) {                      // Ctrl y: redo
                event.preventDefault();
                alert('redo not implemented');
            } 
        } catch(err) {
            if (err.message!='unbreakable') throw err;
            this.historyRollback();
        }

        return new Promise((resolve) => {
            setTimeout(() => {
                this.sanitize();
                cb();
                this.historyStep();
                resolve(this);
            }, 0);
        });

    }

    //
    // History
    //

    // One operation completed, go to next one
    historyStep() {
        let latest=this.history[this.history.length-1];
        let sel = document.defaultView.getSelection();

        if (!latest.dom.length)
            return false;

        latest.cursor.anchorNode = sel.anchorNode.oid;
        latest.cursor.anchorOffset = sel.anchorOffset;
        if (! sel.isCollapsed) {
            latest.cursor.focusNode = sel.focusNode.oid;
            latest.cursor.focusOffset = sel.focusOffset;
        }
        latest.id = Math.random() * 2**31 | 0; // TODO: replace by uuid4 generator

        this.historySend(latest);
        this.history.push({
            cursor: {},
            dom: [],
        });

    }

    // send changes to server
    historySend(item) {
        if (this.collaborate) {
            fetch('/history-push', {
                body: JSON.stringify(item),
                headers: { 'Content-Type': 'application/json;charset=utf-8' },
                method: 'POST',
            }).then(response => {
                console.log(response)
            });
        }
    }

    historyRollback() {
        this.observerFlush();
        this.historyPop(true);
    }

    historyUndo() {
        this.observerFlush();

        // remove the one in progress before removing the last step
        if (this.history.length>1)
            this.historyPop(false);
        this.historyPop(true);
    }
    historyPop(newStep=true) {
        let step = this.history.pop();
        let pos = this.history.length;
        this.history.push({
            cursor: {},
            dom: [],
        });
        // aplly dom changes by reverting history
        while (step.dom.length) {
            let action = step.dom.pop();
            if (!action) break;
            switch (action.type) {
                case "characterData":
                    this.idFind(this.dom, action.id).textContent = action.oldValue;
                    break;
                case "remove":
                    let node = this.unserialize(action.node);
                    if (action.nextId && this.idFind(this.dom, action.nextId)) {
                        this.idFind(this.dom, action.nextId).before(node);
                    } else if (action.previousId && this.idFind(this.dom, action.previousId)) {
                        this.idFind(this.dom, action.previousId).after(node);
                    } else {
                        this.idFind(this.dom, action.parentId).append(node);
                    }
                    break;
                case "add":
                    let el = this.idFind(this.dom, action.id);
                    if (el) el.remove();
            }
        }
        // set cursor to step.cursor
        if (step.cursor.anchorNode) {
            let anchor = this.idFind(this.dom, step.cursor.anchorNode);
            if (anchor)
                setCursor(anchor, step.cursor.anchorOffset);
        }

        this.observerFlush();
        while (this.history.length > pos)
            this.history.pop();

        if (newStep) {
            this.history.push({
                cursor: {},
                dom: [],
            });
        }
    }
}


let editor = new Editor(document.getElementById("dom"));
document.getElementById('vdom').append(editor.vdom)

document.getElementById('domAdd').addEventListener("click", (event) => {
    let newEl = document.createElement('div');
    newEl.innerHTML="This div is in <b>DOM</b> but not in <b>VDOM</b>.";
    editor.observerUnactive();
    editor.dom.querySelector('div,p,li').after(newEl);
    editor.observerActive();
});

document.getElementById('domChange').addEventListener("click", (event) => {
    editor.observerUnactive();
    let li = editor.dom.querySelector('li');
    li.firstChild.nodeValue="Changed in DOM!";
    editor.observerActive();
});

document.getElementById('domReset').addEventListener("click", (event) => {
    editor.observerUnactive();
    let dom = editor.newDom(editor.vdom);
    editor.dom.parentNode.replaceChild(dom, editor.dom);
    editor.dom = dom;
    editor.observerActive();
});

