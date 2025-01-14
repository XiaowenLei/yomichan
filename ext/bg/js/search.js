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


class DisplaySearch extends Display {
    constructor() {
        super($('#spinner'), $('#content'));

        this.optionsContext = {
            depth: 0,
            url: window.location.href
        };

        this.search = $('#search').click(this.onSearch.bind(this));
        this.query = $('#query').on('input', this.onSearchInput.bind(this));
        this.intro = $('#intro');

        this.dependencies = Object.assign({}, this.dependencies, {docRangeFromPoint, docSentenceExtract});

        window.wanakana.bind(this.query.get(0));
    }

    onError(error) {
        window.alert(`Error: ${error.toString ? error.toString() : error}`);
    }

    onSearchClear() {
        this.query.focus().select();
    }

    onSearchInput() {
        this.search.prop('disabled', this.query.val().length === 0);
    }

    async onSearch(e) {
        try {
            e.preventDefault();
            this.intro.slideUp();
            const {length, definitions} = await apiTermsFind(this.query.val(), this.optionsContext);
            super.termsShow(definitions, await apiOptionsGet(this.optionsContext));
        } catch (e) {
            this.onError(e);
        }
    }
}

window.yomichan_search = new DisplaySearch();
