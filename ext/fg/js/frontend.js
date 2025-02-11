/*
 * Copyright (C) 2016-2017  Alex Yatskov <alex@foosoft.net>
 * Author: Alex Yatskov <alex@foosoft.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


class Frontend {
    constructor(popup, ignoreNodes) {
        this.popup = popup;
        this.popupTimer = null;
        this.textSourceLast = null;
        this.pendingLookup = false;
        this.options = null;
        this.ignoreNodes = (Array.isArray(ignoreNodes) && ignoreNodes.length > 0 ? ignoreNodes.join(',') : null);

        this.optionsContext = {
            depth: popup.depth,
            url: popup.url
        };

        this.primaryTouchIdentifier = null;
        this.contextMenuChecking = false;
        this.contextMenuPrevent = false;
        this.contextMenuPreviousRange = null;
        this.mouseDownPrevent = false;
        this.clickPrevent = false;
        this.scrollPrevent = false;
    }

    static create() {
        const initializationData = window.frontendInitializationData;
        const isNested = (initializationData !== null && typeof initializationData === 'object');
        const {id, depth, parentFrameId, ignoreNodes, url} = isNested ? initializationData : {};

        const popup = isNested ? new PopupProxy(depth + 1, id, parentFrameId, url) : PopupProxyHost.instance.createPopup(null);
        const frontend = new Frontend(popup, ignoreNodes);
        frontend.prepare();
        return frontend;
    }

    async prepare() {
        try {
            this.options = await apiOptionsGet(this.getOptionsContext());

            window.addEventListener('message', this.onFrameMessage.bind(this));
            window.addEventListener('mousedown', this.onMouseDown.bind(this));
            window.addEventListener('mousemove', this.onMouseMove.bind(this));
            window.addEventListener('mouseover', this.onMouseOver.bind(this));
            window.addEventListener('mouseout', this.onMouseOut.bind(this));
            window.addEventListener('resize', this.onResize.bind(this));

            if (this.options.scanning.touchInputEnabled) {
                window.addEventListener('click', this.onClick.bind(this));
                window.addEventListener('touchstart', this.onTouchStart.bind(this));
                window.addEventListener('touchend', this.onTouchEnd.bind(this));
                window.addEventListener('touchcancel', this.onTouchCancel.bind(this));
                window.addEventListener('touchmove', this.onTouchMove.bind(this), {passive: false});
                window.addEventListener('contextmenu', this.onContextMenu.bind(this));
            }

            chrome.runtime.onMessage.addListener(this.onBgMessage.bind(this));
        } catch (e) {
            this.onError(e);
        }
    }

    onMouseOver(e) {
        if (e.target === this.popup.container && this.popupTimer !== null) {
            this.popupTimerClear();
        }
    }

    onMouseMove(e) {
        this.popupTimerClear();

        if (
            this.pendingLookup ||
            !this.options.general.enable ||
            (e.buttons & 0x1) !== 0x0 // Left mouse button
        ) {
            return;
        }

        const scanningOptions = this.options.scanning;
        const scanningModifier = scanningOptions.modifier;
        if (!(
            Frontend.isScanningModifierPressed(scanningModifier, e) ||
            (scanningOptions.middleMouse && (e.buttons & 0x4) !== 0x0) // Middle mouse button
        )) {
            return;
        }

        const search = async () => {
            try {
                await this.searchAt(e.clientX, e.clientY, 'mouse');
            } catch (e) {
                this.onError(e);
            }
        };

        if (scanningModifier === 'none') {
            this.popupTimerSet(search);
        } else {
            search();
        }
    }

    onMouseDown(e) {
        if (this.mouseDownPrevent) {
            this.setMouseDownPrevent(false, false);
            this.setClickPrevent(true);
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        this.popupTimerClear();
        this.searchClear();
    }

    onMouseOut(e) {
        this.popupTimerClear();
    }

    onFrameMessage(e) {
        const handlers = {
            popupClose: () => {
                this.searchClear();
            },

            selectionCopy: () => {
                document.execCommand('copy');
            }
        };

        const handler = handlers[e.data];
        if (handler) {
            handler();
        }
    }

    onResize() {
        this.searchClear();
    }

    onClick(e) {
        if (this.clickPrevent) {
            this.setClickPrevent(false);
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }

    onTouchStart(e) {
        if (this.primaryTouchIdentifier !== null && this.getIndexOfTouch(e.touches, this.primaryTouchIdentifier) >= 0) {
            return;
        }

        let touch = this.getPrimaryTouch(e.changedTouches);
        if (this.selectionContainsPoint(window.getSelection(), touch.clientX, touch.clientY)) {
            touch = null;
        }

        this.setPrimaryTouch(touch);
    }

    onTouchEnd(e) {
        if (this.primaryTouchIdentifier === null) {
            return;
        }

        if (this.getIndexOfTouch(e.changedTouches, this.primaryTouchIdentifier) < 0) {
            return;
        }

        this.setPrimaryTouch(this.getPrimaryTouch(this.excludeTouches(e.touches, e.changedTouches)));
    }

    onTouchCancel(e) {
        this.onTouchEnd(e);
    }

    onTouchMove(e) {
        if (!this.scrollPrevent || !e.cancelable || this.primaryTouchIdentifier === null) {
            return;
        }

        const touches = e.changedTouches;
        const index = this.getIndexOfTouch(touches, this.primaryTouchIdentifier);
        if (index < 0) {
            return;
        }

        const touch = touches[index];
        this.searchFromTouch(touch.clientX, touch.clientY, 'touchMove');

        e.preventDefault(); // Disable scroll
    }

    onContextMenu(e) {
        if (this.contextMenuPrevent) {
            this.setContextMenuPrevent(false, false);
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }

    onAfterSearch(newRange, cause, searched, success) {
        if (cause === 'mouse') {
            return;
        }

        if (
            !this.contextMenuChecking ||
            (this.contextMenuPreviousRange === null ? newRange === null : this.contextMenuPreviousRange.equals(newRange))) {
            return;
        }

        if (cause === 'touchStart' && newRange !== null) {
            this.scrollPrevent = true;
        }

        this.setContextMenuPrevent(true, false);
        this.setMouseDownPrevent(true, false);
        this.contextMenuChecking = false;
    }

    onBgMessage({action, params}, sender, callback) {
        const handlers = {
            optionsUpdate: () => {
                this.updateOptions();
            },

            popupSetVisible: ({visible}) => {
                this.popup.setVisible(visible);
            }
        };

        const handler = handlers[action];
        if (handler) {
            handler(params);
            callback();
        }
    }

    onError(error) {
        console.log(error);
    }

    async updateOptions() {
        this.options = await apiOptionsGet(this.getOptionsContext());
        if (!this.options.enable) {
            this.searchClear();
        }
    }

    popupTimerSet(callback) {
        const delay = this.options.scanning.delay;
        if (delay > 0) {
            this.popupTimer = window.setTimeout(callback, delay);
        } else {
            Promise.resolve().then(callback);
        }
    }

    popupTimerClear() {
        if (this.popupTimer !== null) {
            window.clearTimeout(this.popupTimer);
            this.popupTimer = null;
        }
    }

    async searchAt(x, y, cause) {
        if (this.pendingLookup || await this.popup.containsPoint(x, y)) {
            return;
        }

        const textSource = docRangeFromPoint(x, y, this.options);
        let hideResults = textSource === null;
        let searched = false;
        let success = false;

        try {
            if (!hideResults && (!this.textSourceLast || !this.textSourceLast.equals(textSource))) {
                searched = true;
                this.pendingLookup = true;
                const focus = (cause === 'mouse');
                hideResults = !await this.searchTerms(textSource, focus) && !await this.searchKanji(textSource, focus);
                success = true;
            }
        } catch (e) {
            if (window.yomichan_orphaned) {
                if (textSource && this.options.scanning.modifier !== 'none') {
                    this.popup.showOrphaned(
                        textSource.getRect(),
                        textSource.getWritingMode(),
                        this.options
                    );
                }
            } else {
                this.onError(e);
            }
        } finally {
            if (textSource !== null) {
                textSource.cleanup();
            }
            if (hideResults && this.options.scanning.autoHideResults) {
                this.searchClear();
            }

            this.pendingLookup = false;
            this.onAfterSearch(this.textSourceLast, cause, searched, success);
        }
    }

    async searchTerms(textSource, focus) {
        this.setTextSourceScanLength(textSource, this.options.scanning.length);

        const searchText = textSource.text();
        if (searchText.length === 0) {
            return;
        }

        const {definitions, length} = await apiTermsFind(searchText, this.getOptionsContext());
        if (definitions.length === 0) {
            return false;
        }

        textSource.setEndOffset(length);

        const sentence = docSentenceExtract(textSource, this.options.anki.sentenceExt);
        const url = window.location.href;
        this.popup.termsShow(
            textSource.getRect(),
            textSource.getWritingMode(),
            definitions,
            this.options,
            {sentence, url, focus}
        );

        this.textSourceLast = textSource;
        if (this.options.scanning.selectText) {
            textSource.select();
        }

        return true;
    }

    async searchKanji(textSource, focus) {
        this.setTextSourceScanLength(textSource, 1);

        const searchText = textSource.text();
        if (searchText.length === 0) {
            return;
        }

        const definitions = await apiKanjiFind(searchText, this.getOptionsContext());
        if (definitions.length === 0) {
            return false;
        }

        const sentence = docSentenceExtract(textSource, this.options.anki.sentenceExt);
        const url = window.location.href;
        this.popup.kanjiShow(
            textSource.getRect(),
            textSource.getWritingMode(),
            definitions,
            this.options,
            {sentence, url, focus}
        );

        this.textSourceLast = textSource;
        if (this.options.scanning.selectText) {
            textSource.select();
        }

        return true;
    }

    searchClear() {
        this.popup.hide();
        this.popup.clearAutoPlayTimer();

        if (this.options.scanning.selectText && this.textSourceLast) {
            this.textSourceLast.deselect();
        }

        this.textSourceLast = null;
    }

    getPrimaryTouch(touchList) {
        return touchList.length > 0 ? touchList[0] : null;
    }

    getIndexOfTouch(touchList, identifier) {
        for (let i in touchList) {
            let t = touchList[i];
            if (t.identifier === identifier) {
                return i;
            }
        }
        return -1;
    }

    excludeTouches(touchList, excludeTouchList) {
        const result = [];
        for (let r of touchList) {
            if (this.getIndexOfTouch(excludeTouchList, r.identifier) < 0) {
                result.push(r);
            }
        }
        return result;
    }

    setPrimaryTouch(touch) {
        if (touch === null) {
            this.primaryTouchIdentifier = null;
            this.contextMenuPreviousRange = null;
            this.contextMenuChecking = false;
            this.scrollPrevent = false;
            this.setContextMenuPrevent(false, true);
            this.setMouseDownPrevent(false, true);
            this.setClickPrevent(false);
        }
        else {
            this.primaryTouchIdentifier = touch.identifier;
            this.contextMenuPreviousRange = this.textSourceLast ? this.textSourceLast.clone() : null;
            this.contextMenuChecking = true;
            this.scrollPrevent = false;
            this.setContextMenuPrevent(false, false);
            this.setMouseDownPrevent(false, false);
            this.setClickPrevent(false);

            this.searchFromTouch(touch.clientX, touch.clientY, 'touchStart');
        }
    }

    setContextMenuPrevent(value, delay) {
        if (!delay) {
            this.contextMenuPrevent = value;
        }
    }

    setMouseDownPrevent(value, delay) {
        if (!delay) {
            this.mouseDownPrevent = value;
        }
    }

    setClickPrevent(value) {
        this.clickPrevent = value;
    }

    searchFromTouch(x, y, cause) {
        this.popupTimerClear();

        if (!this.options.general.enable || this.pendingLookup) {
            return;
        }

        const search = async () => {
            try {
                await this.searchAt(x, y, cause);
            } catch (e) {
                this.onError(e);
            }
        };

        search();
    }

    selectionContainsPoint(selection, x, y) {
        for (let i = 0; i < selection.rangeCount; ++i) {
            const range = selection.getRangeAt(i);
            for (const rect of range.getClientRects()) {
                if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    return true;
                }
            }
        }
        return false;
    }

    setTextSourceScanLength(textSource, length) {
        textSource.setEndOffset(length);
        if (this.ignoreNodes === null || !textSource.range) {
            return;
        }

        length = textSource.text().length;
        while (textSource.range && length > 0) {
            const nodes = TextSourceRange.getNodesInRange(textSource.range);
            if (!TextSourceRange.anyNodeMatchesSelector(nodes, this.ignoreNodes)) {
                break;
            }
            --length;
            textSource.setEndOffset(length);
        }
    }

    getOptionsContext() {
        this.optionsContext.url = this.popup.url;
        return this.optionsContext;
    }

    static isScanningModifierPressed(scanningModifier, mouseEvent) {
        switch (scanningModifier) {
            case 'alt': return mouseEvent.altKey;
            case 'ctrl': return mouseEvent.ctrlKey;
            case 'shift': return mouseEvent.shiftKey;
            case 'none': return true;
            default: return false;
        }
    }
}

window.yomichan_frontend = Frontend.create();
