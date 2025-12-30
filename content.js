/**
 * Formats numbers with spaces as thousand separators.
 */
function formatNumber(number) {
    const parts = number.toString().split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return parts.join(".");
};

class CurrencyConverter {
    constructor(apiKey, config, currencies) {
        this.apiKey = apiKey.trim();
        this.config = config;
        this.currencies = currencies;

        // Cache currency codes and symbols
        this.codes = [...new Set(Object.values(currencies).flat())];
        this.symbols = Object.keys(currencies);

        // State
        this.conversionRates = null;
        this.usage = null;

        // Initialize
        this.patterns = this.buildPatterns();
        this.ui = this.createUI();
        this.attachEvents();
    }

    buildPatterns() {
        const escapedCodes = this.codes.map(RegExp.escape);
        const escapedSymbols = this.symbols.map(RegExp.escape);
        const joinedSymbols = escapedSymbols.join("");

        // Regex to match currency codes (e.g. 100 USD or USD 100)
        const codePattern = new RegExp(
            String.raw`(?<![^\s\-+${joinedSymbols}])(?:(?<value>\d+[\d ,]*(\.\d)?[\d ,]*)[ ]*(?<code>${escapedCodes.join("|")})[ ]*|[ ]*(?<code2>${escapedCodes.join("|")})[ ]*(?<value2>\d+[\d ,]*(\.\d)?[\d ,]*))\.?(?![^\s+\-,;?!${joinedSymbols}])`,
            "i"
        );

        // Regex to match currency symbols (e.g. $100 or 100$)
        const symbolPattern = new RegExp(
            String.raw`(?:(?<![^\s\-+])(?<value2>\d+[\d ,]*(\.\d)?[\d ]*)[ ]*(?<symbol2>${escapedSymbols.join("|")})|(?<![^\s\w\-+])(?<symbol>${escapedSymbols.join("|")})[ ]*(?<value>\d+[\d ,]*(\.\d)?[\d ]*))\.?(?![^\s+\-,;?!])`,
            "i"
        );

        return { codePattern, symbolPattern };
    }

    createUI() {
        const container = document.createElement("div");
        container.className = "currconv-popup";
        container.dataset.result = "success";
        container.dataset.show = "false";

        const loader = document.createElement("div");
        loader.className = "currconv-loader";
        loader.dataset.show = "false";
        container.appendChild(loader);

        const message = document.createElement("div");
        message.className = "currconv-popup-message";
        message.style.fontSize = `${this.config.fontSize.message}pt`;
        container.appendChild(message);

        const currenciesList = document.createElement("div");
        currenciesList.className = "currconv-popup-currencies";
        currenciesList.style.fontSize = `${this.config.fontSize.currencies}pt`;
        container.appendChild(currenciesList);

        const updatedTime = document.createElement("div");
        updatedTime.className = "currconv-popup-updated";
        updatedTime.style.fontSize = `${this.config.fontSize.ratesUpdated}pt`;
        updatedTime.style.display = this.config.displayModule.ratesUpdated ? "block" : "none";
        container.appendChild(updatedTime);

        const usageInfo = document.createElement("div");
        usageInfo.className = "currconv-popup-updated";
        usageInfo.style.fontSize = `${this.config.fontSize.usage}pt`;
        usageInfo.style.display = this.config.displayModule.usage ? "block" : "none";
        container.appendChild(usageInfo);

        document.body.appendChild(container);

        return { container, loader, message, currenciesList, updatedTime, usageInfo };
    }

    attachEvents() {
        document.addEventListener("mouseup", (e) => this.handleSelection(e));
        document.addEventListener("mousedown", (e) => this.handleOutsideClick(e));
    }

    handleOutsideClick(e) {
        if (e.target !== this.ui.container && !this.ui.container.contains(e.target)) {
            this.ui.container.dataset.show = "false";
        }
    }

    async handleSelection() {
        const selection = window.getSelection();
        const selectedText = selection.toString();

        if (!selectedText || !selection.rangeCount) {
            this.ui.container.dataset.show = "false";
            return;
        }

        // Reset UI
        this.ui.currenciesList.innerHTML = "";
        this.ui.updatedTime.innerHTML = "";
        this.ui.message.innerHTML = "";

        // Parse Selection
        const { fromCurrencies, fromValue } = this.parseSelection(selectedText);

        if (!fromValue || !fromCurrencies || fromCurrencies.length === 0) {
            return;
        }

        // Fetch Data
        const error = await this.updateDataIfNeeded();

        // Render
        this.renderPopup(error, fromCurrencies, fromValue);
        this.positionPopup(selection);
    }

    parseSelection(text) {
        const codeMatches = text.match(this.patterns.codePattern);
        const symbolMatches = text.match(this.patterns.symbolPattern);

        const matchedCode = codeMatches?.groups?.code || codeMatches?.groups?.code2;
        const matchedSymbol = symbolMatches?.groups?.symbol || symbolMatches?.groups?.symbol2;

        let fromCurrencies = [];
        if (matchedCode) {
            fromCurrencies = [matchedCode];
        } else if (matchedSymbol) {
            const mapped = this.currencies[matchedSymbol];
            if (Array.isArray(mapped)) {
                fromCurrencies = mapped;
            } else if (mapped) {
                fromCurrencies = [mapped];
            }
        }

        // Filter valid currencies
        fromCurrencies = fromCurrencies.filter(c => this.codes.includes(c));

        let valueStr = codeMatches?.groups?.value || codeMatches?.groups?.value2 || symbolMatches?.groups?.value || symbolMatches?.groups?.value2;

        if (!valueStr)
            return { fromCurrencies: null, fromValue: null };

        const fromValue = parseFloat(valueStr.replace(/[\s,]/g, ""));
        return { fromCurrencies, fromValue };
    }

    async updateDataIfNeeded() {
        if (!chrome.runtime?.id)
            return "Please reload the page.";

        try {
            const stored = await chrome.storage.local.get(["conversionRates"]);
            this.conversionRates = stored.conversionRates;

            const passedHours = this.conversionRates
                ? (new Date() - this.conversionRates.timestamp * 1000) / 1000 / 60 / 60
                : Infinity;

            const shouldFetchRates = !this.conversionRates || passedHours > this.config.updateFrequencyHours;

            // Fetch Usage if needed
            if (shouldFetchRates || this.config.displayModule.usage) {
                const usageData = await this.fetchUsage();
                if (usageData.error)
                    return this.handleApiError(usageData);
                this.usage = usageData.data.usage;
            }

            // Fetch Rates if needed
            if (shouldFetchRates) {
                console.log("CurrConv: Fetching rates");

                // Check limits
                if (this.usage && (this.usage.requests_remaining === 0)) {
                    const message = `You hit the API access limit.<br>Your quota will reset in ${this.usage.days_remaining} days.`;
                    console.warn(`CurrConv warning: ${message.replace('<br>', ' ')}`);
                    return message;
                }

                this.ui.loader.dataset.show = "true";
                this.ui.message.innerHTML = "Fetching latest rates...";
                this.ui.container.dataset.show = "true"; // Show popup while loading

                const ratesData = await this.fetchRates();
                this.ui.loader.dataset.show = "false";

                if (ratesData.error) return this.handleApiError(ratesData);

                this.conversionRates = ratesData;
                chrome.storage.local.set({ conversionRates: ratesData });
            }
            return ""; // No error
        } catch (e) {
            console.error("CurrConv error:", e);
            this.ui.loader.dataset.show = "false";
            return "Something went wrong.";
        }
    }

    async fetchUsage() {
        const response = await fetch(`https://openexchangerates.org/api/usage.json?app_id=${this.apiKey}`);
        return response.json();
    }

    async fetchRates() {
        const response = await fetch(
            `https://openexchangerates.org/api/latest.json?app_id=${this.apiKey}&symbols=${this.codes.join(",")}`
        );
        return response.json();
    }

    handleApiError(response) {
        const code = response.message || response.description;
        let message = `Error: ${code}`;

        switch (response.message) {
            case "missing_app_id":
                message = "Missing API key.";
                break;
            case "invalid_app_id":
                message = "Invalid API key.";
                break;
            case "access_restricted":
            case "not_allowed":
                message = "Quota exceeded (access restricted)";
                break;
        }
        console.error(`CurrConv error: ${message}`, response);
        return message;
    }

    renderPopup(errorMessage, fromCurrencies, fromValue) {
        this.ui.message.innerHTML = errorMessage;

        if (!this.conversionRates) {
            this.ui.container.dataset.result = "error";
            if (!errorMessage)
                this.ui.message.innerHTML = "No conversion data available.";
        } else {
            if (errorMessage) {
                this.ui.container.dataset.result = "warning";
            } else {
                this.ui.container.dataset.result = "success";
            }
            
            this.renderConversions(fromCurrencies, fromValue);
            this.ui.updatedTime.innerHTML = new Date(this.conversionRates.timestamp * 1000).toLocaleString(this.config.dateFormat);
        }


        if (this.usage) {
            this.ui.usageInfo.innerHTML = `${this.usage.requests_remaining} requests left.`;
        }

        this.ui.container.dataset.show = "true";
    }

    renderConversions(fromCurrencies, fromValue) {
        let html = "";
        const limit = this.config.maxCurrencies || Infinity;

        for (const currency of fromCurrencies.slice(0, limit)) {
            const rate = this.conversionRates.rates[currency];
            if (!rate) continue;

            const valueInUSD = (1 / rate) * fromValue;
            const valueInTarget = valueInUSD * this.conversionRates.rates[this.config.convertTo];

            const convertedStr = formatNumber(valueInTarget.toFixed(this.config.decimals));
            const fromStr = formatNumber(fromValue);

            html += `
                <div class="currconv-currency-from-value">${fromStr}</div>
                <div class="currconv-currency-from-currency">${currency}</div>
                <div class="currconv-currency-equals">=</div>
                <div class="currconv-currency-to-value">${convertedStr}</div>
                <div class="currconv-currency-to-currency">${this.config.convertTo}</div>
            `;
        }
        this.ui.currenciesList.innerHTML = html;
    }

    positionPopup(selection) {
        if (!selection.rangeCount) return;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const popup = this.ui.container;

        const popupShowValue = popup.dataset.show;
        popup.dataset.show = "true";

        let top, left;
        if (rect.left + popup.offsetWidth < document.body.clientWidth) {
            left = rect.left;
        } else {
            left = rect.right - popup.offsetWidth;
        }

        if (rect.top - popup.offsetHeight - 5 > 0) {
            top = rect.top - popup.offsetHeight - 5;
        } else {
            top = rect.bottom + 5;
        }

        // Clamp to viewport
        const x = Math.max(10, Math.min(document.body.clientWidth - popup.offsetWidth - 10, left));
        const y = Math.max(10, Math.min(document.body.clientHeight - popup.offsetHeight - 10, top));

        popup.style.left = `${x}px`;
        popup.style.top = `${y}px`;

        popup.dataset.show = popupShowValue;
    }
}

// Init
(async () => {
    try {
        const [apiKey, config, currencies] = await Promise.all([
            fetch(chrome.runtime.getURL("api.key")).then(response => response.text()),
            fetch(chrome.runtime.getURL("config.json")).then(response => response.json()),
            fetch(chrome.runtime.getURL("currencies.json")).then(response => response.json())
        ]);
    
        new CurrencyConverter(apiKey, config, currencies);
    } catch (error) {
        console.error("CurrConv: Failed to initialize.", error);
    }
})();