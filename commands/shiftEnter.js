"use strict";

import {
    isFakeLineBreak,
    prepareUpdate,
    setCursorEnd,
    splitTextNode,
} from "../utils/utils.js";

Text.prototype.oShiftEnter = function (offset) {
    this.parentElement.oShiftEnter(splitTextNode(this, offset));
};

HTMLElement.prototype.oShiftEnter = function (offset) {
    const restore = prepareUpdate(this, offset);

    const brEl = document.createElement('BR');
    if (offset >= this.childNodes.length) {
        this.appendChild(brEl);
    } else {
        this.insertBefore(brEl, this.childNodes[offset]);
    }
    if (isFakeLineBreak(brEl)) {
        brEl.before(document.createElement('BR'));
    }

    restore();

    setCursorEnd(brEl);
};
