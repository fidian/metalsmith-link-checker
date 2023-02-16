"use strict";

const http = require("http");
const https = require("https");
const path = require("path");

const debug = require("debug")("metalsmith-link-checker");
const async = require("async");
const linkedom = require("linkedom");
const deepmerge = require("deepmerge");
const userAgents = require("top-user-agents");

/**
 * Return a fake user agent.
 * @returns {string}
 */
const userAgent = userAgents[0];

/**
 * A lenient WHATWG version of url.parse().
 * @param {String} input
 * @returns {{}|URL}
 */
const urlParse = (input) => {
    try {
        return new URL(input);
    } catch (err) {
        return {};
    }
};

/**
 * A Metalsmith files object.
 * @typedef {Object.<string, {}>} metalsmithFiles
 */

/**
 * An object of a link in filename.
 * @typedef {{filename: string, link: string}} filenameAndLink
 */

/**
 * An object of a link in a filename, with a validation result.
 * @typedef {{filename: string, link: string, result: ?string}} filenameAndLinkWithResult
 */

/**
 * Gather all links from all HTML files.
 * @param {Object} metalsmith
 * @param {metalsmithFiles} files
 * @param {Object} options
 * @returns {Array.<filenameAndLink>}
 */
const htmlLinks = (metalsmith, files, options) => {
    // For each HTML file that matches the given pattern
    const htmlFiles = metalsmith.match(
        options.html.pattern,
        Object.keys(files)
    );
    return htmlFiles.reduce((arr, filename) => {
        debug(`Scanning file: ${filename}`);
        const file = files[filename];
        const dom = linkedom.parseHTML(file.contents.toString());

        const normalizedFilename = filename.replace(/[/\\]/g, "/");
        return arr.concat(
            // For each given tag
            ...Object.keys(options.html.tags).map((tag) => {
                let attributes = options.html.tags[tag];
                if (!Array.isArray(attributes)) {
                    attributes = [attributes];
                }

                return []
                    .concat(
                        // For each given attribute, get the value of it
                        ...attributes.map((attribute) =>
                            dom.document
                                .querySelectorAll(
                                    `${tag}[${attribute}][${attribute}!='']`
                                )
                                .map((elem) => {
                                    return elem.attributes.filter(
                                        (attr) => attr.name === attribute
                                    )[0].value;
                                })
                        )
                    )
                    .map((link) => ({ filename: normalizedFilename, link }));
            })
        );
    }, []);
};

/**
 * @typedef {function} validator
 * @param {string} link
 * @param {Object} options Plugin options
 * @param {validatorCallback} asyncCallback
 */

/**
 * @callback validatorCallback
 * @param {Object} err
 * @param {?string} validationError
 */

/**
 * Validate a FaceTime link.
 * @type {validator}
 */
const validFacetime = (link) => {
    // https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/FacetimeLinks/FacetimeLinks.html
    if (link === "facetime:") {
        return null;
    }
    if (link.indexOf("@") === -1 && !link.match(/[0-9]/)) {
        return "invalid";
    }
    if (link.indexOf("@") >= 0) {
        if (!link.match(/^facetime:[^@]+@.+$/)) {
            return "invalid email address";
        }
    } else {
        if (link.indexOf(" ") !== -1) {
            return "contains a space";
        }
        if (!link.match(/^facetime:[0-9.+-]+$/)) {
            return "invalid phone number";
        }
    }
    return null;
};

const validUrlCache = {};

/**
 * Validate a remote HTTP or HTTPS URL.
 * @type {validator}
 */
const validUrl = (link, options, callback, attempt = 1, method = "HEAD") => {
    const cacheAndCallback = (err, result) => {
        // Retry failures if we haven't reached the retry limit
        if (result && attempt <= options.attempts) {
            setTimeout(() => {
                validUrl(link, options, callback, attempt + 1, method);
            }, Math.min(1000, 100 * 2 ** attempt));
            return;
        }
        // Otherwise, store the result and call the callback
        validUrlCache[link] = result;
        callback(err, result);
    };
    if (link in validUrlCache) {
        callback(null, validUrlCache[link]);
        return;
    }

    const library = link.slice(0, 5) === "https" ? https : http;
    const req = library.request(
        link,
        {
            method,
            headers: {
                // TODO: something to fix Pixabay
                "User-Agent": options.userAgent
            },
            timeout: options.timeout,
            rejectUnauthorized: false
        },
        (res) => {
            // Re-attempt HEAD 405s as GETs
            if (res.statusCode === 405 && method !== "GET") {
                validUrl(link, options, callback, attempt, "GET");
                return;
            }

            if (!res) {
                cacheAndCallback(null, "no response");
            } else if (res.statusCode >= 400 && res.statusCode <= 599) {
                cacheAndCallback(null, `HTTP ${res.statusCode}`);
            } else {
                cacheAndCallback(null, null);
            }
        }
    );

    req.on("error", (err) => {
        // Re-attempt HEAD errors as GETs
        if (method !== "GET") {
            validUrl(link, options, callback, attempt, "GET");
            return;
        }

        cacheAndCallback(null, err.message);
    });

    req.on("timeout", () => {
        req.destroy(); // cause an error
    });

    req.end();
};

/**
 * Validate a mailto: link.
 * @type {validator}
 */
const validMailto = (link) => {
    // https://www.w3docs.com/snippets/html/how-to-create-mailto-links.html
    if (!link.match(/^mailto:[^@]+/)) {
        return "invalid local-part";
    }
    if (!link.match(/^mailto:[^@]+@[^?]+/)) {
        return "invalid domain";
    }
    if (
        !link.match(
            /^mailto:[^@]+@[^?]+(\?(subject|cc|bcc|body)=[^&]+(&(subject|cc|bcc|body)=[^&]+)?)?$/
        )
    ) {
        return "invalid query params";
    }
    return null;
};

/**
 * Validate a sms: link.
 * @type {validator}
 */
const validSms = (link) => {
    // https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/SMSLinks/SMSLinks.html
    if (!link.replace(/ /g, "").match(/^sms:([0-9.+-]+)?$/)) {
        return "invalid";
    }
    if (link.indexOf(" ") !== -1) {
        return "contains a space";
    }
    return null;
};

/**
 * Validate a tel: link.
 * @type {validator}
 */
const validTel = (link) => {
    // https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/PhoneLinks/PhoneLinks.html#//apple_ref/doc/uid/TP40007899-CH6-SW1
    if (!link.replace(/ /g, "").match(/^tel:([0-9.+-]+)?$/)) {
        return "invalid";
    }
    if (link.indexOf(" ") !== -1) {
        return "contains a space";
    }
    return null;
};

/**
 * Return if a `dest` link from a `src` file is valid or not.
 * @param {metalsmithFiles} files
 * @param {string} src
 * @param {string} dest
 * @returns {boolean}
 */
const validLocal = (files, src, dest) => {
    // TODO: anchor validation
    // Strip trailing anchor link
    dest = dest.replace(/#.*$/, "");

    // Strip trailing query string parameters
    dest = dest.replace(/\?.*$/, "");

    // Reference to self is always valid
    if (dest === "" || dest === "." || dest === "./") {
        return true;
    }

    // Resolve links and handle root-relative links
    const linkPath = dest.charAt(0) === '/' ? dest.substr(1) : path.join(path.dirname(src), dest);

    // Reference to self is always valid
    if (linkPath === "" || linkPath === "." || linkPath === "./") {
        return true;
    }

    if (linkPath in files) {
        return true;
    }

    const index = path.join(linkPath, "index.html");

    if (index in files) {
        return true;
    }

    return false;
};

/**
 * @type {Object.<string, validator>}
 */
const protocolValidators = {
    "facetime:": validFacetime,
    "facetime-audio:": validFacetime,
    "http:": validUrl,
    "https:": validUrl,
    "mailto:": validMailto,
    "sms:": validSms,
    "tel:": validTel
};

/**
 * Plugin entrypoint.
 * @param {Object} options
 * @returns {function(Object.<string, Object>, Object, function)}
 */
module.exports = (options) => {
    options = deepmerge(
        {
            html: {
                pattern: "**/*.html",
                tags: {
                    a: "href",
                    img: ["src", "data-src"],
                    link: "href",
                    script: "src"
                }
            },
            ignore: [],
            timeout: 10 * 1000,
            attempts: 3,
            userAgent,
            parallelism: 100
        },
        options || {}
    );

    return (files, metalsmith, done) => {
        const normalizedFilenames = Object.keys(files).reduce(
            (reducer, filename) => {
                reducer[filename.replace(/[/\\]/g, "/")] = true;
                return reducer;
            },
            {}
        );

        // Gather a list of filename + link combinations, and remove ignored links
        options.ignore = options.ignore.map((pattern) => new RegExp(pattern));
        const duplicateDetection = new Set();
        let filenamesAndLinks = [
            ...htmlLinks(metalsmith, files, options)
            // TODO: CSS files
            // TODO: manifest files
        ];
        debug(`Detected ${filenamesAndLinks.length} links to check`);
            // Filter this out if this a duplicate of an item earlier in the array
        filenamesAndLinks = filenamesAndLinks.filter((v1) => {
                const stringVersion = JSON.stringify(v1);
                if (duplicateDetection.has(stringVersion)) {
                    return false;
                }
                duplicateDetection.add(stringVersion);
                return true;
            });
        debug(`Eliminated duplicates, down to ${filenamesAndLinks.length} links to check`);
            // Filter this out if any ignore regex matches
        filenamesAndLinks = filenamesAndLinks.filter((filenameAndLink) => {
                const comparator = (re) => re.test(filenameAndLink.link);
                return !options.ignore.some(comparator);
            });
        debug(`Eliminated ignored links, down to ${filenamesAndLinks.length} links to check`);
            // Shuffle to try to disperse checking the same domain concurrently
        filenamesAndLinks = filenamesAndLinks.sort(() => Math.random() - 0.5);

        // For each link, find the files it is broken for
        async.mapLimit(
            filenamesAndLinks,
            options.parallelism,
            (filenameAndLink, callback) => {
                const callbackResult = (err, result) =>
                    callback(err, { ...filenameAndLink, result });
                const { filename, link } = filenameAndLink;

                // Validate links with a protocol (remote links)
                const linkUrl = urlParse(link);
                if (linkUrl.protocol) {
                    if (protocolValidators[linkUrl.protocol] !== undefined) {
                        const result = protocolValidators[linkUrl.protocol](
                            link,
                            options,
                            callbackResult
                        );
                        if (result === undefined) {
                            // Validation function didn't return anything, it will call the callback for us
                            return;
                        }
                        // Otherwise, call the callback with the validation result
                        callbackResult(null, result);
                        return;
                    }

                    // Assume all unknown protocols are valid
                    callbackResult(null, null);
                    return;
                }

                // Validate local files
                callbackResult(
                    null,
                    validLocal(normalizedFilenames, filename, link)
                        ? null
                        : "not found"
                );
            },
            (err, /** @type {filenameAndLinkWithResult} */ result) => {
                if (err) {
                    done(err);
                    return;
                }

                const filenamesToLinkErrors = result
                    .filter((filenameAndLink) => filenameAndLink.result)
                    .reduce((obj, filenameAndLink) => {
                        if (!obj[filenameAndLink.filename]) {
                            obj[filenameAndLink.filename] = [];
                        }
                        obj[filenameAndLink.filename].push(
                            `${filenameAndLink.link} (${filenameAndLink.result})`
                        );
                        return obj;
                    }, {});

                // Return a pretty formatted error if there are bad links
                if (Object.keys(filenamesToLinkErrors).length) {
                    const message = Object.keys(filenamesToLinkErrors)
                        .sort()
                        .map((filename) => {
                            const output = filenamesToLinkErrors[filename]
                                .sort()
                                .map((linkError) => `  ${linkError}`)
                                .join("\n");
                            return `${filename}:\n${output}`;
                        })
                        .join("\n\n");
                    done(`Broken links found:\n\n${message}`);
                }

                done();
            }
        );
    };
};
