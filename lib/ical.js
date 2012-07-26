/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
var ICAL = ICAL || {};
ICAL.helpers = {
  initState: function initState(aLine, aLineNr) {
    return {
      buffer: aLine,
      line: aLine,
      lineNr: aLineNr,
      character: 0,
      currentData: null,
      parentData: []
    };
  },

  initComponentData: function initComponentData(aName) {
    return {
      name: aName,
      type: "COMPONENT",
      value: []
    };
  },

  dumpn: function () {
    if (!ICAL.debug) {
      return;
    }

    if(typeof (console) !== 'undefined' && 'log' in console) {
      ICAL.helpers.dumpn = function consoleDumpn(input) {
        return console.log(input);
      }
    } else {
      ICAL.helpers.dumpn = function geckoDumpn(input) {
        dump(input + '\n');
      }
    }

    return ICAL.helpers.dumpn(arguments[0]);
  },

  mixin: function (obj, data) {
    if(data) {
      for(var k in data) {
        obj[k] = data[k];
      }
    }
    return obj;
  },

  unfoldline: function unfoldline(aState) {
    // Section 3.1
    // if the line ends with a CRLF
    // and the next line starts with a LINEAR WHITESPACE (space, htab, ...)

    // then remove the CRLF and the whitespace to unsplit the line
    var moreLines = true;
    var line = "";

    while(moreLines) {
      moreLines = false;
      var pos = aState.buffer.search(/\r?\n/);
      if(pos > -1) {
        var len = (aState.buffer[pos] == "\r" ? 2 : 1);
        var nextChar = aState.buffer.substr(pos + len, 1)
        if(nextChar.match(/^[ \t]$/)) {
          moreLines = true;
          line += aState.buffer.substr(0, pos);
          aState.buffer = aState.buffer.substr(pos + len + 1);
        } else {
          // We're at the end of the line, copy the found chunk
          line += aState.buffer.substr(0, pos);
          aState.buffer = aState.buffer.substr(pos + len);
        }
      } else {
        line += aState.buffer;
        aState.buffer = "";
      }
    }
    return line;
  },

  foldline: function foldline(aLine) {
    var result = "";
    var line = aLine || "";

    while(line.length) {
      result += ICAL.newLineChar + " " + line.substr(0, ICAL.foldLength);
      line = line.substr(ICAL.foldLength);
    }
    return result.substr(ICAL.newLineChar.length + 1);
  },

  ensureKeyExists: function (obj, key, defvalue) {
    if(!(key in obj)) {
      obj[key] = defvalue;
    }
  },

  hasKey: function (obj, key) {
    return(obj && key in obj && obj[key]);
  },

  pad2: function pad(data) {
    return("00" + data).substr(-2);
  },

  trunc: function trunc(number) {
    return(number < 0 ? Math.ceil(number) : Math.floor(number));
  }
};
var ICAL = ICAL || {};

(function () {
  ICAL.serializer = {
    serializeToIcal: function (obj, name, isParam) {
      if(obj && obj.icalclass) {
        return obj.toString();
      }

      var str = "";

      if(obj.type == "COMPONENT") {
        str = "BEGIN:" + obj.name + ICAL.newLineChar;
        for each(var sub in obj.value) {
          str += this.serializeToIcal(sub) + ICAL.newLineChar;
        }
        str += "END:" + obj.name;
      } else {
        str += ICAL.icalparser.stringifyProperty(obj);
      }
      return str;
    }
  };
}());
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
// TODO validate known parameters
// TODO make sure all known types don't contain junk
// TODO tests for parsers
// TODO SAX type parser
// TODO structure data in components
// TODO enforce uppercase when parsing
// TODO optionally preserve value types that are default but explicitly set
// TODO floating timezone
var ICAL = ICAL || {};
(function () {
  /* NOTE: I'm not sure this is the latest syntax...

     {
       X-WR-CALNAME: "test",
       components: {
         VTIMEZONE: { ... },
         VEVENT: {
             "uuid1": {
                 UID: "uuid1",
                 ...
                 components: {
                     VALARM: [
                         ...
                     ]
                 }
             }
         },
         VTODO: { ... }
       }
     }
     */

  // Exports

  function ParserError(aState, aMessage) {
    this.mState = aState;
    this.name = "ParserError";
    if(aState) {
      var lineNrData = ("lineNr" in aState ? aState.lineNr + ":" : "") + ("character" in aState && !isNaN(aState.character) ? aState.character + ":" : "");

      var message = lineNrData + aMessage;
      if("buffer" in aState) {
        if(aState.buffer) {
          message += " before '" + aState.buffer + "'";
        } else {
          message += " at end of line";
        }
      }
      if("line" in aState) {
        message += " in '" + aState.line + "'";
      }
      this.message = message;
    } else {
      this.message = aMessage;
    }

    // create stack
    try {
      throw new Error();
    } catch(e) {
      var split = e.stack.split('\n');
      split.shift();
      this.stack = split.join('\n');
    }
  }

  ParserError.prototype = Object.create(Error.prototype);
  ParserError.prototype.constructor = ParserError;

  var parser = {};
  ICAL.icalparser = parser;

  parser.lexContentLine = function lexContentLine(aState) {
    // contentline   = name *(";" param ) ":" value CRLF
    // The corresponding json object will be:
    // { name: "name", parameters: { key: "value" }, value: "value" }
    var lineData = {};

    // Parse the name
    lineData.name = parser.lexName(aState);

    // Read Paramaters, if there are any.
    if(aState.buffer.substr(0, 1) == ";") {
      lineData.parameters = {};
      while(aState.buffer.substr(0, 1) == ";") {
        aState.buffer = aState.buffer.substr(1);
        var param = parser.lexParam(aState);
        lineData.parameters[param.name] = param.value;
      }
    }

    // Read the value
    parser.expectRE(aState, /^:/, "Expected ':'");
    lineData.value = parser.lexValue(aState);
    //FIXME:? There may be some cases where this is needed
    //but its perfectly possible that this line is blank.

    parser.expectEnd(aState, "Junk at End of Line");
    return lineData;
  };

  parser.lexName = function lexName(aState) {
    function parseIanaToken(aState) {
      var match = parser.expectRE(aState, /^([A-Za-z0-9-]+)/, "Expected IANA Token");
      return match[1];
    }

    function parseXName(aState) {
      var error = "Expected XName";
      var value = "X-";
      var match = parser.expectRE(aState, /^X-/, error);

      // Vendor ID
      if(match = parser.expectOptionalRE(aState, /^([A-Za-z0-9]+-)/, error)) {
        value += match[1];
      }

      // Remaining part
      match = parser.expectRE(aState, /^([A-Za-z0-9-]+)/, error);
      value += match[1];

      return value;
    }
    return parser.parseAlternative(aState, parseXName, parseIanaToken);
  };

  parser.lexValue = function lexValue(aState) {
    // VALUE-CHAR = WSP / %x21-7E / NON-US-ASCII
    // ; Any textual character

    if (aState.buffer.length === 0) {
      return aState.buffer;
    }

    // TODO the unicode range might be wrong!
    var match = parser.expectRE(aState,
                                /*  WSP|%x21-7E|NON-US-ASCII  */
                                /^([ \t\x21-\x7E\u00C2-\uF400]+)/,
                                "Invalid Character in value");

    return match[1];
  };

  parser.lexParam = function lexParam(aState) {
    // read param name
    var name = parser.lexName(aState);
    parser.expectRE(aState, /^=/, "Expected '='");

    // read param value
    var values = parser.parseList(aState, parser.lexParamValue, ",");
    return {
      name: name,
      value: (values.length == 1 ? values[0] : values)
    };
  };

  parser.lexParamValue = function lexParamValue(aState) {
    // CONTROL = %x00-08 / %x0A-1F / %x7F
    // ; All the controls except HTAB
    function parseQuotedString(aState) {
      parser.expectRE(aState, /^"/, "Expecting Quote Character");
      // QSAFE-CHAR    = WSP / %x21 / %x23-7E / NON-US-ASCII
      // ; Any character except CONTROL and DQUOTE

      var match = parser.expectRE(aState, /^([^"\x00-\x08\x0A-\x1F\x7F]*)/, "Invalid Param Value");
      parser.expectRE(aState, /^"/, "Expecting Quote Character");
      return match[1];
    }

    function lexParamText(aState) {
      // SAFE-CHAR     = WSP / %x21 / %x23-2B / %x2D-39 / %x3C-7E / NON-US-ASCII
      // ; Any character except CONTROL, DQUOTE, ";", ":", ","
      var match = parser.expectRE(aState, /^([^";:,\x00-\x08\x0A-\x1F\x7F]*)/, "Invalid Param Value");
      return match[1];
    }

    return parser.parseAlternative(aState, parseQuotedString, lexParamText);
  };

  parser.parseContentLine = function parseContentLine(aState, aLineData) {

    switch(aLineData.name) {
    case "BEGIN":
      var newdata = ICAL.helpers.initComponentData(aLineData.value);
      if(aState.currentData) {
        // If there is already data (i.e this is not the top level
        // component), then push the new data to its values and
        // stack the parent data.
        aState.currentData.value.push(newdata);
        aState.parentData.push(aState.currentData);
      }

      aState.currentData = newdata; // set the new data array
      break;
    case "END":
      if(aState.currentData.name != aLineData.value) {
        throw new ParserError(aState, "Unexpected END:" + aLineData.value + ", expected END:" + aState.currentData.name);
      }
      if(aState.parentData.length) {
        aState.currentData = aState.parentData.pop();
      }
      break;
    default:
      ICAL.helpers.dumpn("parse " + aLineData.toSource());
      parser.detectParameterType(aLineData);
      parser.detectValueType(aLineData);
      ICAL.helpers.dumpn("parse " + aLineData.toSource());
      aState.currentData.value.push(aLineData);
      break;
    }
  },

  parser.detectParameterType = function detectParameterType(aLineData) {
    for(var name in aLineData.parameters) {
      var paramType = "TEXT";

      if(name in ICAL.design.param && "valueType" in ICAL.design.param[name]) {
        paramType = ICAL.design.param[name].valueType;
      }
      var paramData = {
        value: aLineData.parameters[name],
        type: paramType
      };

      aLineData.parameters[name] = paramData;
    }
  };

  parser.detectValueType = function detectValueType(aLineData) {
    var valueType = "TEXT";
    var defaultType = null;
    if(aLineData.name in ICAL.design.property && "defaultType" in ICAL.design.property[aLineData.name]) {
      valueType = ICAL.design.property[aLineData.name].defaultType;
    }

    if("parameters" in aLineData && "VALUE" in aLineData.parameters) {
      ICAL.helpers.dumpn("VAAAA: " + aLineData.parameters.VALUE.toSource());
      valueType = aLineData.parameters.VALUE.value.toUpperCase();
    }

    if(!(valueType in ICAL.design.value)) {
      throw new ParserError(aLineData, "Invalid VALUE Type '" + valueType);
    }

    aLineData.type = valueType;

    // It could be a multi-value value, we have to take that apart first
    function unwrapMultiValue(x, separator) {
      var values = [];

      function replacer(s, a) {
        values.push(a);
        return "";
      }
      var re = new RegExp("(.*?[^\\\\])" + separator, "g");
      values.push(x.replace(re, replacer));
      return values;
    }

    if(aLineData.name in ICAL.design.property) {
      if(ICAL.design.property[aLineData.name].multiValue) {
        aLineData.value = unwrapMultiValue(aLineData.value, ",");
      } else if(ICAL.design.property[aLineData.name].structuredValue) {
        aLineData.value = unwrapMultiValue(aLineData.value, ";");
      } else {
        aLineData.value = [aLineData.value];
      }
    } else {
      aLineData.value = [aLineData.value];
    }

    if("unescape" in ICAL.design.value[valueType]) {
      var unescaper = ICAL.design.value[valueType].unescape;
      for(var idx in aLineData.value) {
        aLineData.value[idx] = unescaper(aLineData.value[idx], aLineData.name);
      }
    }

    return aLineData;
  }

  parser.validateValue = function validateValue(aLineData, aValueType, aValue, aCheckParams) {
    var propertyData = ICAL.design.property[aLineData.name];
    var valueData = ICAL.design.value[aValueType];

    // TODO either make validators just consume the value, then check for end here (possibly requires returning remainder or renaming buffer<->value in the states)
    // validators don't really need the whole linedata

    if(!aValue.match) {
      ICAL.helpers.dumpn("MAAA: " + aValue + " ? " + aValue.toSource());
    }

    if(valueData.matches) {
      // Test against regex
      if(!aValue.match(valueData.matches)) {
        throw new ParserError(aLineData, "Value '" + aValue + "' for " + aLineData.name + " is not " + aValueType);
      }
    } else if("validate" in valueData) {
      // Validator throws an error itself if needed
      var objData = valueData.validate(aValue);

      // Merge in extra value data, if it exists
      ICAL.helpers.mixin(aLineData, objData);
    } else if("values" in valueData) {
      // Fixed list of values
      if(valueData.values.indexOf(aValue) < 0) {
        throw new ParserError(aLineData, "Value for " + aLineData.name + " is not a " + aValueType);
      }
    }

    if(aCheckParams && "requireParam" in valueData) {
      for(var param in valueData.requireParam) {
        if(!("parameters" in aLineData) || !(param in aLineData.parameters) || aLineData.parameters[param].value != valueData.requireParam[param]) {
          throw new ParserError(aLineData, "Value requires " + param + "=" + valueData.requireParam[param]);
        }
      }
    }

    return aLineData;
  };

  parser.parseValue = function parseValue(aStr, aType) {
    var lineData = {
      value: [aStr]
    }
    return parser.validateValue(lineData, aType, aStr, false);
  };

  parser.decorateValue = function decorateValue(aType, aValue) {
    if(aType in ICAL.design.value && "decorate" in ICAL.design.value[aType]) {
      return ICAL.design.value[aType].decorate(aValue);
    } else {
      return ICAL.design.value.TEXT.decorate(aValue);
    }
  };

  parser.stringifyProperty = function stringifyProperty(aLineData) {
    ICAL.helpers.dumpn("Stringify: " + aLineData.toSource());
    var str = aLineData.name;
    if(aLineData.parameters) {
      for(var key in aLineData.parameters) {
        str += ";" + key + "=" + aLineData.parameters[key].value;
      }
    }

    str += ":" + parser.stringifyValue(aLineData);

    return ICAL.helpers.foldline(str);
  };

  parser.stringifyValue = function stringifyValue(aLineData) {
    function arrayStringMap(arr, func) {
      var newArr = [];
      for(var idx in arr) {
        newArr[idx] = func(arr[idx].toString());
      }
      return newArr;
    }

    if(aLineData) {
      var values = aLineData.value;
      if(aLineData.type in ICAL.design.value && "escape" in ICAL.design.value[aLineData.type]) {
        var escaper = ICAL.design.value[aLineData.type].escape;
        values = arrayStringMap(values, escaper);
      }

      var separator = ",";
      if(aLineData.name in ICAL.design.property && ICAL.design.property[aLineData.name].structuredValue) {
        separator = ";";
      }

      return values.join(separator);
    } else {
      return null;
    }
  };

  parser.parseDateOrDateTime = function parseDateOrDateTime(aState) {
    var data = parser.parseDate(aState);

    if(parser.expectOptionalRE(aState, /^T/)) {
      // This has a time component, parse it
      var time = parser.parseTime(aState);

      if(parser.expectOptionalRE(aState, /^Z/)) {
        data.timezone = "Z";
      }
      ICAL.helpers.mixin(data, time);
    }
    return data;
  };

  parser.parseDateTime = function parseDateTime(aState) {
    var data = parser.parseDate(aState);
    parser.expectRE(aState, /^T/, "Expected 'T'");

    var time = parser.parseTime(aState);

    if(parser.expectOptionalRE(aState, /^Z/)) {
      data.timezone = "Z";
    }

    ICAL.helpers.mixin(data, time);
    return data;
  };

  parser.parseDate = function parseDate(aState) {
    var match = parser.expectRE(aState, /^((\d{4})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01]))/, "Expected YYYYMMDD Date");
    return {
      year: parseInt(match[2], 10),
      month: parseInt(match[3], 10),
      day: parseInt(match[4], 10)
    };
    // TODO timezone?
  };

  parser.parseTime = function parseTime(aState) {
    var match = parser.expectRE(aState, /^(([01][0-9]|2[0-3])([0-5][0-9])([0-5][0-9]|60))/, "Expected HHMMSS Time");
    return {
      hour: parseInt(match[2], 10),
      minute: parseInt(match[3], 10),
      second: parseInt(match[4], 10)
    };
  };

  parser.parseDuration = function parseDuration(aState) {
    var error = "Expected Duration Value";

    function parseDurSecond(aState) {
      return {
        seconds: parseInt(parser.expectRE(aState, /^((\d+)S)/, "Expected Seconds")[2], 10)
      };
    }

    function parseDurMinute(aState) {
      var data = {};
      var minutes = parser.expectRE(aState, /^((\d+)M)/, "Expected Minutes");
      try {
        data = parseDurSecond(aState);
      } catch(e) {
        // seconds are optional, its ok
        if(!(e instanceof ParserError)) {
          throw e;
        }
      }
      data.minutes = parseInt(minutes[2], 10);
      return data;
    }

    function parseDurHour(aState) {
      var data = {};
      var hours = parser.expectRE(aState, /^((\d+)H)/, "Expected Hours");
      try {
        data = parseDurMinute(aState);
      } catch(e) {
        // seconds are optional, its ok
        if(!(e instanceof ParserError)) {
          throw e;
        }
      }

      data.hours = parseInt(hours[2], 10);
      return data;
    }

    function parseDurWeek(aState) {
      return {
        weeks: parser.expectRE(aState, /^((\d+)W)/, "Expected Weeks")[2]
      };
    }

    function parseDurTime(aState) {
      parser.expectRE(aState, /^T/, "Expected Time Value");
      return parser.parseAlternative(aState, parseDurHour, parseDurMinute, parseDurSecond);
    }

    function parseDurDate(aState) {
      var days = parser.expectRE(aState, /^((\d+)D)/, "Expected Days");
      var data;

      try {
        data = parseDurTime(aState);
      } catch(e) {
        // Its ok if this fails
        if(!(e instanceof ParserError)) {
          throw e;
        }
      }

      if(data) {
        data.days = days[2];
      } else {
        data = {
          days: parseInt(days[2], 10)
        };
      }
      return data;
    }

    var factor = parser.expectRE(aState, /^([+-]?P)/, error);

    var durData = parser.parseAlternative(aState, parseDurDate, parseDurTime, parseDurWeek);
    parser.expectEnd(aState, "Junk at end of DURATION value");

    durData.factor = (factor[1] == "-P" ? -1 : 1);
    return durData;
  };

  parser.parsePeriod = function parsePeriod(aState) {
    var dtime = parser.parseDateTime(aState);
    parser.expectRE(aState, /\//, "Expected '/'");

    var dtdur = parser.parseAlternative(aState, parser.parseDateTime, parser.parseDuration);
    var data = {
      start: dtime
    }
    if("factor" in dtdur) {
      data.duration = dtdur;
    } else {
      data.end = dtdur;
    }
    return data;
  },

  parser.parseRecur = function parseRecur(aState) {
    // TODO this function is quite cludgy, maybe it should be done differently
    function parseFreq(aState) {
      parser.expectRE(aState, /^FREQ=/, "Expected Frequency");
      var match = parser.expectRE(aState, /^(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)/, "Exepected Frequency Value");
      return {
        "FREQ": match[1]
      };
    }

    function parseUntil(aState) {
      parser.expectRE(aState, /^UNTIL=/, "Expected Frequency");
      var untilDate = parser.parseDateOrDateTime(aState);
      return {
        "UNTIL": untilDate
      };
    }

    function parseCount(aState) {
      parser.expectRE(aState, /^COUNT=/, "Expected Count");
      var match = parser.expectRE(aState, /^(\d+)/, "Expected Digit(s)");
      return {
        "COUNT": parseInt(match[1], 10)
      };
    }

    function parseInterval(aState) {
      parser.expectRE(aState, /^INTERVAL=/, "Expected Interval");
      var match = parser.expectRE(aState, /^(\d+)/, "Expected Digit(s)");
      return {
        "INTERVAL": parseInt(match[1], 10)
      };
    }

    function parseBySecond(aState) {
      function parseSecond(aState) {
        var value = parser.expectRE(aState, /^(60|[1-5][0-9]|[0-9])/, "Expected Second")[1];
        return parseInt(value, 10);
      }
      parser.expectRE(aState, /^BYSECOND=/, "Expected BYSECOND");
      var seconds = parser.parseList(aState, parseSecond, ",");
      return {
        "BYSECOND": seconds
      };
    }

    function parseByMinute(aState) {
      function parseMinute(aState) {
        var value = parser.expectRE(aState, /^([1-5][0-9]|[0-9])/, "Expected Minute")[1];
        return parseInt(value, 10);
      }
      parser.expectRE(aState, /^BYMINUTE=/, "Expected BYMINUTE");
      var minutes = parser.parseList(aState, parseMinute, ",");
      return {
        "BYMINUTE": minutes
      };
    }

    function parseByHour(aState) {
      function parseHour(aState) {
        var value = parser.expectRE(aState, /^(2[0-3]|1[0-9]|[0-9])/, "Expected Hour")[1];
        return parseInt(value, 10);
      }
      parser.expectRE(aState, /^BYHOUR=/, "Expected BYHOUR");
      var hours = parser.parseList(aState, parseHour, ",");
      return {
        "BYHOUR": hours
      };
    }

    function parseByDay(aState) {
      function parseWkDayNum(aState) {
        var value = "";
        var match = parser.expectOptionalRE(aState, /^([+-])/);
        if(match) {
          value += match[1]
        }

        match = parser.expectOptionalRE(aState, /^(5[0-3]|[1-4][0-9]|[1-9])/);
        if(match) {
          value += match[1]
        }

        match = parser.expectRE(aState, /^(SU|MO|TU|WE|TH|FR|SA)/, "Expected Week Ordinals");
        value += match[1];
        return value;
      }
      parser.expectRE(aState, /^BYDAY=/, "Expected BYDAY Rule");
      var wkdays = parser.parseList(aState, parseWkDayNum, ",");
      return {
        "BYDAY": wkdays
      };
    }

    function parseByMonthDay(aState) {
      function parseMoDayNum(aState) {
        var value = "";
        var match = parser.expectOptionalRE(aState, /^([+-])/);
        if(match) {
          value += match[1]
        }

        match = parser.expectRE(aState, /^(3[01]|[12][0-9]|[1-9])/);
        value += match[1];
        return parseInt(value, 10);
      }
      parser.expectRE(aState, /^BYMONTHDAY=/, "Expected BYMONTHDAY Rule");
      var modays = parser.parseList(aState, parseMoDayNum, ",");
      return {
        "BYMONTHDAY": modays
      };
    }

    function parseByYearDay(aState) {
      function parseYearDayNum(aState) {
        var value = "";
        var match = parser.expectOptionalRE(aState, /^([+-])/);
        if(match) {
          value += match[1]
        }

        match = parser.expectRE(aState, /^(36[0-6]|3[0-5][0-9]|[12][0-9][0-9]|[1-9][0-9]|[1-9])/);
        value += match[1];
        return parseInt(value, 10);
      }
      parser.expectRE(aState, /^BYYEARDAY=/, "Expected BYYEARDAY Rule");
      var yrdays = parser.parseList(aState, parseYearDayNum, ",");
      return {
        "BYYEARDAY": yrdays
      };
    }

    function parseByWeekNo(aState) {
      function parseWeekNum(aState) {
        var value = "";
        var match = parser.expectOptionalRE(aState, /^([+-])/);
        if(match) {
          value += match[1]
        }

        match = parser.expectRE(aState, /^(5[0-3]|[1-4][0-9]|[1-9])/);
        value += match[1];
        return parseInt(value, 10);
      }
      parser.expectRE(aState, /^BYWEEKNO=/, "Expected BYWEEKNO Rule");
      var weeknos = parser.parseList(aState, parseWeekNum, ",");
      return {
        "BYWEEKNO": weeknos
      };
    }

    function parseByMonth(aState) {
      function parseMonthNum(aState) {
        var match = parser.expectRE(aState, /^(1[012]|[1-9])/, "Expected Month number");
        return parseInt(match[1], 10);
      }
      parser.expectRE(aState, /^BYMONTH=/, "Expected BYMONTH Rule");
      var monums = parser.parseList(aState, parseMonthNum, ",");
      return {
        "BYMONTH": monums
      };
    }

    function parseBySetPos(aState) {
      function parseSpList(aState) {
        var value = parser.expectRE(aState, /^(36[0-6]|3[0-5][0-9]|[12][0-9][0-9]|[1-9][0-9]|[1-9])/)[1];

        return parseInt(value, 10);
      }
      parser.expectRE(aState, /^BYSETPOS=/, "Expected BYSETPOS Rule");
      var spnums = parser.parseList(aState, parseSpList, ",");
      return {
        "BYSETPOS": spnums
      };
    }

    function parseWkst(aState) {
      parser.expectRE(aState, /^WKST=/, "Expected WKST");
      var match = parser.expectRE(aState, /^(SU|MO|TU|WE|TH|FR|SA)/, "Expected Weekday Name");
      return {
        "WKST": match[1]
      };
    }

    function parseRulePart(aState) {
      return parser.parseAlternative(aState,
      parseFreq, parseUntil, parseCount, parseInterval,
      parseBySecond, parseByMinute, parseByHour, parseByDay,
      parseByMonthDay, parseByYearDay, parseByWeekNo,
      parseByMonth, parseBySetPos, parseWkst);
    }

    // One or more rule parts
    var value = parser.parseList(aState, parseRulePart, ";");
    var data = {};
    for each(var mbr in value) {
      ICAL.helpers.mixin(data, mbr);
    }

    // Make sure there's no junk at the end
    parser.expectEnd(aState, "Junk at end of RECUR value");
    return data;
  };

  parser.parseUtcOffset = function parseUtcOffset(aState) {
    if(aState.buffer == "-0000" || aState.buffer == "-000000") {
      throw new ParserError(aState, "Invalid value for utc offset: " + aState.buffer);
    }
    var match = parser.expectRE(aState, /^(([+-])([01][0-9]|2[0-3])([0-5][0-9])([0-5][0-9])?)$/, "Expected valid utc offset");
    return {
      factor: (match[2] == "-" ? -1 : 1),
      hours: parseInt(match[3], 10),
      minutes: parseInt(match[4], 10)
    };
  };

  parser.parseAlternative = function parseAlternative(aState /* parserFunc, ... */ ) {
    var tokens = null;
    var args = Array.slice(arguments);
    var parser;
    args.shift();
    var errors = [];

    while(!tokens && (parser = args.shift())) {
      try {
        tokens = parser(aState);
      } catch(e) {
        if(e instanceof ParserError) {
          errors.push(e);
          tokens = null;
        } else {
          throw e;
        }
      }
    }

    if(!tokens) {
      var message = errors.join("\nOR ") || "No Tokens found";
      throw new ParserError(aState, message);
    }

    return tokens;
  },

  parser.parseList = function parseList(aState, aElementFunc, aSeparator) {
    var listvals = [];

    listvals.push(aElementFunc(aState));
    var re = new RegExp("^" + aSeparator + "");
    while(parser.expectOptionalRE(aState, re)) {
      listvals.push(aElementFunc(aState));
    }
    return listvals;
  };

  parser.expectOptionalRE = function expectOptionalRE(aState, aRegex) {
    var match = aState.buffer.match(aRegex);
    if(match) {
      var count = ("1" in match ? match[1].length : match[0].length);
      aState.buffer = aState.buffer.substr(count);
      aState.character += count;
    }
    return match;
  };

  parser.expectRE = function expectRE(aState, aRegex, aErrorMessage) {
    var match = parser.expectOptionalRE(aState, aRegex);
    if(!match) {
      throw new ParserError(aState, aErrorMessage);
    }
    return match;
  };

  parser.expectEnd = function expectEnd(aState, aErrorMessage) {
    if(aState.buffer.length > 0) {
      throw new ParserError(aState, aErrorMessage);
    }
  }

  /* Possible shortening:
      - pro: retains order
      - con: datatypes not obvious
      - pro: not so many objects created

    {
      "begin:vcalendar": [
        {
          prodid: "-//Example Inc.//Example Client//EN",
          version: "2.0"
          "begin:vtimezone": [
            {
              "last-modified": [{
                type: "date-time",
                value: "2004-01-10T03:28:45Z"
              }],
              tzid: "US/Eastern"
              "begin:daylight": [
                {
                  dtstart: {
                    type: "date-time",
                    value: "2000-04-04T02:00:00"
                  }
                  rrule: {
                    type: "recur",
                    value: {
                      freq: "YEARLY",
                      byday: ["1SU"],
                      bymonth: ["4"],
                    }
                  }
                }
              ]
            }
          ],
          "begin:vevent": [
            {
              category: [{
                type: "text"
                value: "multi1,multi2,multi3" // have icalcomponent take apart the multivalues
              },{
                type "text"
                value: "otherprop1"
              }]
            }
          ]
        }
      ]
    }
    */
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
var ICAL = ICAL || {};
ICAL.design = {
  param: {
    // Although the syntax is DQUOTE uri DQUOTE, I don't think we should
    // enfoce anything aside from it being a valid content line.
    // "ALTREP": { ... },

    // CN just wants a param-value
    // "CN": { ... }

    "CUTYPE": {
      values: ["INDIVIDUAL", "GROUP", "RESOURCE", "ROOM", "UNKNOWN"],
      allowXName: true,
      allowIanaToken: true
    },

    "DELEGATED-FROM": {
      valueType: "CAL-ADDRESS",
      multiValue: true
    },
    "DELEGATED-TO": {
      valueType: "CAL-ADDRESS",
      multiValue: true
    },
    // "DIR": { ... }, // See ALTREP
    "ENCODING": {
      values: ["8BIT", "BASE64"]
    },
    // "FMTTYPE": { ... }, // See ALTREP
    "FBTYPE": {
      values: ["FREE", "BUSY", "BUSY-UNAVAILABLE", "BUSY-TENTATIVE"],
      allowXName: true,
      allowIanaToken: true
    },
    // "LANGUAGE": { ... }, // See ALTREP
    "MEMBER": {
      valueType: "CAL-ADDRESS",
      multiValue: true
    },
    "PARTSTAT": {
      // TODO These values are actually different per-component
      values: ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED", "COMPLETED", "IN-PROCESS"],
      allowXName: true,
      allowIanaToken: true
    },
    "RANGE": {
      values: ["THISANDFUTURE"]
    },
    "RELATED": {
      values: ["START", "END"]
    },
    "RELTYPE": {
      values: ["PARENT", "CHILD", "SIBLING"],
      allowXName: true,
      allowIanaToken: true
    },
    "ROLE": {
      values: ["REQ-PARTICIPANT", "CHAIR", "OPT-PARTICIPANT", "NON-PARTICIPANT"],
      allowXName: true,
      allowIanaToken: true
    },
    "RSVP": {
      valueType: "BOOLEAN"
    },
    "SENT-BY": {
      valueType: "CAL-ADDRESS"
    },
    "TZID": {
      matches: /^\//
    },
    "VALUE": {
      values: ["BINARY", "BOOLEAN", "CAL-ADDRESS", "DATE", "DATE-TIME", "DURATION", "FLOAT", "INTEGER", "PERIOD", "RECUR", "TEXT", "TIME", "URI", "UTC-OFFSET"],
      allowXName: true,
      allowIanaToken: true
    },
  },

  // When adding a value here, be sure to add it to the parameter types!
  value: {

    "BINARY": {
      matches: /^([A-Za-z0-9+\/]{4})*([A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/,
      requireParam: {
        "ENCODING": "BASE64"
      },
      decorate: function (aString) {
        return ICAL.icalbinary.fromString(aString);
      }
    },
    "BOOLEAN": {
      values: ["TRUE", "FALSE"],
      decorate: function (aValue) {
        return ICAL.icalvalue.fromString(aValue, "BOOLEAN");
      }
    },
    "CAL-ADDRESS": {
      // needs to be an uri
    },
    "DATE": {
      validate: function (aValue) {
        var state = {
          buffer: aValue
        };
        var data = ICAL.icalparser.parseDate(state);
        ICAL.icalparser.expectEnd(state, "Junk at end of DATE value");
        return data;
      },
      decorate: function (aValue) {
        return ICAL.icaltime.fromString(aValue);
      }
    },
    "DATE-TIME": {
      validate: function (aValue) {
        var state = {
          buffer: aValue
        };
        var data = ICAL.icalparser.parseDateTime(state);
        ICAL.icalparser.expectEnd(state, "Junk at end of DATE-TIME value");
        return data;
      },

      decorate: function (aValue) {
        return ICAL.icaltime.fromString(aValue);
      }
    },
    "DURATION": {
      validate: function (aValue) {
        var state = {
          buffer: aValue
        };
        var data = ICAL.icalparser.parseDuration(state);
        ICAL.icalparser.expectEnd(state, "Junk at end of DURATION value");
        return data;
      },
      decorate: function (aValue) {
        return ICAL.icalduration.fromString(aValue);
      }
    },
    "FLOAT": {
      matches: /^[+-]?\d+\.\d+$/,
      decorate: function (aValue) {
        return ICAL.icalvalue.fromString(aValue, "FLOAT");
      }
    },
    "INTEGER": {
      matches: /^[+-]?\d+$/,
      decorate: function (aValue) {
        return ICAL.icalvalue.fromString(aValue, "INTEGER");
      }
    },
    "PERIOD": {
      validate: function (aValue) {
        var state = {
          buffer: aValue
        };
        var data = ICAL.icalparser.parsePeriod(state);
        ICAL.icalparser.expectEnd(state, "Junk at end of PERIOD value");
        return data;
      },

      decorate: function (aValue) {
        return ICAL.icalperiod.fromString(aValue);
      }
    },
    "RECUR": {
      validate: function (aValue) {
        var state = {
          buffer: aValue
        };
        var data = ICAL.icalparser.parseRecur(state);
        ICAL.icalparser.expectEnd(state, "Junk at end of RECUR value");
        return data;
      },

      decorate: function decorate(aValue) {
        return ICAL.icalrecur.fromString(aValue);
      },
    },

    "TEXT": {
      matches: /.*/,
      decorate: function (aValue) {
        return ICAL.icalvalue.fromString(aValue, "TEXT");
      },
      unescape: function (aValue, aName) {
        return aValue.replace(/\\\\|\\;|\\,|\\[Nn]/g, function (str) {
          switch(str) {
          case "\\\\":
            return "\\";
          case "\\;":
            return ";";
          case "\\,":
            return ",";
          case "\\n":
          case "\\N":
            return "\n";
          default:
            return str;
          }
        });
      },

      escape: function escape(aValue, aName) {
        return aValue.replace(/\\|;|,|\n/g, function (str) {
          switch(str) {
          case "\\":
            return "\\\\";
          case ";":
            return "\\;";
          case ",":
            return "\\,";
          case "\n":
            return "\\n";
          default:
            return str;
          }
        });
      },
    },

    "TIME": {
      validate: function (aValue) {
        var state = {
          buffer: aValue
        };
        var data = ICAL.icalparser.parseTime(state);
        ICAL.icalparser.expectEnd(state, "Junk at end of TIME value");
        return data;
      }
    },

    "URI": {
      // TODO
      /* ... */
    },

    "UTC-OFFSET": {
      validate: function (aValue) {
        var state = {
          buffer: aValue
        };
        var data = ICAL.icalparser.parseUtcOffset(state);
        ICAL.icalparser.expectEnd(state, "Junk at end of UTC-OFFSET value");
        return data;
      },

      decorate: function (aValue) {
        return ICAL.icalutcoffset.fromString(aValue);
      }
    }
  },

  property: {
    decorate: function decorate(aData, aParent) {
      return new ICAL.icalproperty(aData, aParent);
    },
    "ATTACH": {
      defaultType: "URI"
    },
    "ATTENDEE": {
      defaultType: "CAL-ADDRESS"
    },
    "CATEGORIES": {
      defaultType: "TEXT",
      multiValue: true
    },
    "COMPLETED": {
      defaultType: "DATE-TIME"
    },
    "CREATED": {
      defaultType: "DATE-TIME"
    },
    "DTEND": {
      defaultType: "DATE-TIME",
      allowedTypes: ["DATE-TIME", "DATE"]
    },
    "DTSTAMP": {
      defaultType: "DATE-TIME"
    },
    "DTSTART": {
      defaultType: "DATE-TIME",
      allowedTypes: ["DATE-TIME", "DATE"]
    },
    "DUE": {
      defaultType: "DATE-TIME",
      allowedTypes: ["DATE-TIME", "DATE"]
    },
    "DURATION": {
      defaultType: "DURATION"
    },
    "EXDATE": {
      defaultType: "DATE-TIME",
      allowedTypes: ["DATE-TIME", "DATE"]
    },
    "EXRULE": {
      defaultType: "RECUR"
    },
    "FREEBUSY": {
      defaultType: "PERIOD",
      multiValue: true
    },
    "GEO": {
      defaultType: "FLOAT",
      structuredValue: true
    },
    /* TODO exactly 2 values */"LAST-MODIFIED": {
      defaultType: "DATE-TIME"
    },
    "ORGANIZER": {
      defaultType: "CAL-ADDRESS"
    },
    "PERCENT-COMPLETE": {
      defaultType: "INTEGER"
    },
    "REPEAT": {
      defaultType: "INTEGER"
    },
    "RDATE": {
      defaultType: "DATE-TIME",
      allowedTypes: ["DATE-TIME", "DATE", "PERIOD"]
    },
    "RECURRENCE-ID": {
      defaultType: "DATE-TIME",
      allowedTypes: ["DATE-TIME", "DATE"]
    },
    "RESOURCES": {
      defaultType: "TEXT",
      multiValue: true
    },
    "REQUEST-STATUS": {
      defaultType: "TEXT",
      structuredValue: true
    },
    "PRIORITY": {
      defaultType: "INTEGER"
    },
    "RRULE": {
      defaultType: "RECUR"
    },
    "SEQUENCE": {
      defaultType: "INTEGER"
    },
    "TRIGGER": {
      defaultType: "DURATION",
      allowedTypes: ["DURATION", "DATE-TIME"]
    },
    "TZOFFSETFROM": {
      defaultType: "UTC-OFFSET"
    },
    "TZOFFSETTO": {
      defaultType: "UTC-OFFSET"
    },
    "TZURL": {
      defaultType: "URI"
    },
    "URL": {
      defaultType: "URI"
    },
  },

  component: {
    decorate: function decorate(aData, aParent) {
      return new ICAL.icalcomponent(aData, aParent);
    },
    "VEVENT": {}
  },
};
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icalcomponent = function icalcomponent(data, parent) {
    this.wrappedJSObject = this;
    this.parent = parent;
    this.fromData(data);
  }

  ICAL.icalcomponent.prototype = {

    data: null,
    name: "",
    components: null,
    properties: null,

    icalclass: "icalcomponent",

    clone: function clone() {
      return new ICAL.icalcomponent(this.undecorate(), this.parent);
    },

    fromData: function fromData(data) {
      if(!data) {
        data = ICAL.helpers.initComponentData(null);
      }
      this.data = data;
      this.data.value = this.data.value || [];
      this.data.type = this.data.type || "COMPONENT";
      this.components = {};
      this.properties = {};

      // Save the name directly on the object, as we want this accessed
      // from the outside.
      this.name = this.data.name;
      delete this.data.name;

      var value = this.data.value;

      for(var key in value) {
        var keyname = value[key].name;
        if(value[key].type == "COMPONENT") {
          value[key] = new ICAL.icalcomponent(value[key], this);
          ICAL.helpers.ensureKeyExists(this.components, keyname, []);
          this.components[keyname].push(value[key]);
        } else {
          value[key] = new ICAL.icalproperty(value[key], this);
          ICAL.helpers.ensureKeyExists(this.properties, keyname, []);
          this.properties[keyname].push(value[key]);
        }
      }
    },

    undecorate: function undecorate() {
      var newdata = [];
      for each(var data in this.data.value) {
        newdata.push(data.undecorate());
      }
      return {
        name: this.name,
        type: "COMPONENT",
        value: newdata
      };
    },

    getFirstSubcomponent: function getFirstSubcomponent(aType) {
      var comp = null;
      if(aType) {
        var ucType = aType.toUpperCase();
        if(ucType in this.components && this.components[ucType] && this.components[ucType].length > 0) {
          comp = this.components[ucType][0];
        }
      } else {
        for(var thiscomp in this.components) {
          comp = this.components[thiscomp][0];
          break;
        }
      }
      return comp;
    },

    getAllSubcomponents: function getAllSubcomponents(aType) {
      var comps = [];
      if(aType && aType != "ANY") {
        var ucType = aType.toUpperCase();
        if(ucType in this.components) {
          for(var compKey in this.components[ucType]) {
            comps.push(this.components[ucType][compKey]);
          }
        }
      } else {
        for(var compName in this.components) {
          for(var compKey in this.components[compName]) {
            comps.push(this.components[compName][compKey]);
          }
        }
      }
      return comps;
    },

    addSubcomponent: function addSubcomponent(aComp, aCompName) {
      var ucName, comp;
      var comp;
      if(aComp.icalclass == "icalcomponent") {
        ucName = aComp.name;
        comp = aComp.clone();
        comp.parent = this;
      } else {
        ucName = aCompName.toUpperCase();
        comp = new ICAL.icalcomponent(aComp, ucName, this);
      }

      this.data.value.push(comp);
      ICAL.helpers.ensureKeyExists(this.components, ucName, []);
      this.components[ucName].push(comp);
    },

    removeSubcomponent: function removeSubComponent(aName) {
      var ucName = aName.toUpperCase();
      for each(var comp in this.components[ucName]) {
        var pos = this.data.value.indexOf(comp);
        if(pos > -1) {
          this.data.value.splice(pos, 1);
        }
      }

      delete this.components[ucName];
    },

    hasProperty: function hasProperty(aName) {
      var ucName = aName.toUpperCase();
      return(ucName in this.properties);
    },

    getFirstProperty: function getFirstProperty(aName) {
      var prop = null;
      if(aName) {
        var ucName = aName.toUpperCase();
        if(ucName in this.properties && this.properties[ucName]) {
          prop = this.properties[ucName][0];
        }
      } else {
        for each(var p in this.properties) {
          prop = p;
          break;
        }
      }
      return prop;
    },

    getFirstPropertyValue: function getFirstPropertyValue(aName) {
      // TODO string value?
      var prop = this.getFirstProperty(aName);
      return (prop ? prop.getFirstValue() : null);
    },

    getAllProperties: function getAllProperties(aName) {
      var props = [];
      if(aName && aName != "ANY") {
        var ucType = aName.toUpperCase();
        if(ucType in this.properties) {
          props = this.properties[ucType].concat([]);
        }
      } else {
        for(var propName in this.properties) {
          props = props.concat(this.properties[propName]);
        }
      }
      return props;
    },

    addPropertyWithValue: function addStringProperty(aName, aValue) {
      var ucName = aName.toUpperCase();
      var lineData = ICAL.icalparser.detectValueType({
        name: ucName,
        value: aValue
      });

      var prop = ICAL.icalproperty.fromData(lineData);
      ICAL.helpers.dumpn("Adding property " + ucName + "=" + aValue);
      return this.addProperty(prop);
    },

    addProperty: function addProperty(aProp) {
      var prop = aProp;
      if(aProp.parent) {
        prop = aProp.clone();
      }
      aProp.parent = this;

      ICAL.helpers.ensureKeyExists(this.properties, aProp.name, []);
      this.properties[aProp.name].push(aProp);
      ICAL.helpers.dumpn("DATA IS: " + this.data.toSource());
      this.data.value.push(aProp);
      ICAL.helpers.dumpn("Adding property " + aProp);
    },

    removeProperty: function removeProperty(aName) {
      var ucName = aName.toUpperCase();
      for each(var prop in this.properties[ucName]) {
        var pos = this.data.value.indexOf(prop);
        if(pos > -1) {
          this.data.value.splice(pos, 1);
        }
      }
      delete this.properties[ucName];
    },

    clearAllProperties: function clearAllProperties() {
      this.properties = {};
      for(var i = this.data.value.length - 1; i >= 0; i--) {
        if(this.data.value[i].type != "COMPONENT") {
          delete this.data.value[i];
        }
      }
    },

    _valueToJSON: function(value) {
      if (value && value.icaltype) {
        return value.toString();
      }

      if (typeof(value) === 'object') {
        return this._undecorateJSON(value);
      }

      return value;
    },

    _undecorateJSON: function(object) {
      if (object instanceof Array) {
        var result = [];
        var len = object.length;

        for (var i = 0; i < len; i++) {
          result.push(this._valueToJSON(object[i]));
        }

      } else {
        var result = {};
        var key;

        for (key in object) {
          if (object.hasOwnProperty(key)) {
            result[key] = this._valueToJSON(object[key]);
          }
        }
      }

      return result;
    },

    /**
     * Exports the components values to a json friendly
     * object. You can use JSON.stringify directly on
     * components as a result.
     */
    toJSON: function toJSON() {
      return this._undecorateJSON(this.undecorate());
    },

    toString: function toString() {
      var str = ICAL.helpers.foldline("BEGIN:" + this.name) + ICAL.newLineChar;
      for(var key in this.data.value) {
        str += this.data.value[key].toString() + ICAL.newLineChar;
      }
      str += ICAL.helpers.foldline("END:" + this.name);
      return str;
    }
  };

  ICAL.icalcomponent.fromString = function icalcomponent_from_string(str) {
    return ICAL.toJSON(str, true);
  };

  ICAL.icalcomponent.fromData = function icalcomponent_from_data(aData) {
    return new ICAL.icalcomponent(aData);
  };
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icalproperty = function icalproperty(data, parent) {
    this.wrappedJSObject = this;
    this.parent = parent;
    this.fromData(data);
  }

  ICAL.icalproperty.prototype = {
    parent: null,
    data: null,
    name: null,
    icalclass: "icalproperty",

    clone: function clone() {
      return new ICAL.icalproperty(this.undecorate(), this.parent);
    },

    fromData: function fromData(aData) {
      if(!aData.name) {
        ICAL.helpers.dumpn("Missing name: " + aData.toSource());
      }
      this.name = aData.name;
      this.data = aData;
      this.setValues(this.data.value, this.data.type);
      delete this.data.name;
    },

    undecorate: function () {
      var values = []
      for each(var val in this.data.value) {
        if("undecorate" in val) {
          values.push(val.undecorate());
        } else {
          values.push(val);
        }
      }
      var obj = {
        name: this.name,
        type: this.data.type,
        value: values
      };
      if(this.data.parameters) {
        obj.parameters = this.data.parameters;
      }
      return obj;
    },

    toString: function toString() {
      return ICAL.icalparser.stringifyProperty({
        name: this.name,
        type: this.data.type,
        value: this.data.value,
        parameters: this.data.parameters,
      });
    },

    getStringValue: function getStringValue() {
      ICAL.helpers.dumpn("GV: " + ICAL.icalparser.stringifyValue(this.data));
      return ICAL.icalparser.stringifyValue(this.data);
    },

    setStringValue: function setStringValue(val) {
      this.setValue(val, this.data.type);
      // TODO force TEXT or rename method to something like setParseValue()
    },

    getFirstValue: function getValue() {
      return(this.data.value ? this.data.value[0] : null);
    },

    getValues: function getValues() {
      return(this.data.value ? this.data.value : []);
    },

    setValue: function setValue(aValue, aType) {
      return this.setValues([aValue], aType);
    },

    setValues: function setValues(aValues, aType) {
      var newValues = [];
      var newType = null;
      for each(var value in aValues) {
        if(value.icalclass && value.icaltype) {
          if(newType && newType != value.icaltype) {
            throw new Error("All values must be of the same type!");
          } else {
            newType = value.icaltype;
          }
          newValues.push(value);
        } else {
          var type;
          if(aType) {
            type = aType;
          } else if(typeof value == "string") {
            type = "TEXT";
          } else if(typeof value == "number") {
            type = (Math.floor(value) == value ? "INTEGER" : "FLOAT");
          } else if(typeof value == "boolean") {
            type = "BOOLEAN";
            value = (value ? "TRUE" : "FALSE");
          } else {
            throw new ParserError(null, "Invalid value: " + value);
          }

          if(newType && newType != type) {
            throw new Error("All values must be of the same type!");
          } else {
            newType = type;
          }
          ICAL.icalparser.validateValue(this.data, type, "" + value, true);
          newValues.push(ICAL.icalparser.decorateValue(type, "" + value));
        }
      }

      this.data.value = newValues;
      this.data.type = newType;
      return aValues;
    },

    getValueType: function getValueType() {
      return this.data.type;
    },

    getName: function getName() {
      return this.name;
    },

    getParameterValue: function getParameter(aName) {
      var value = null;
      var ucName = aName.toUpperCase();
      if(ICAL.helpers.hasKey(this.data.parameters, ucName)) {
        value = this.data.parameters[ucName].value;
      }
      return value;
    },

    getParameterType: function getParameterType(aName) {
      var type = null;
      var ucName = aName.toUpperCase();
      if(ICAL.helpers.hasKey(this.data.parameters, ucName)) {
        type = this.data.parameters[ucName].type;
      }
      return type;
    },

    setParameter: function setParameter(aName, aValue, aType) {
      // TODO autodetect type by name
      var ucName = aName.toUpperCase();
      ICAL.helpers.ensureKeyExists(this.data, "parameters", {});
      this.data.parameters[ucName] = {
        type: aType || "TEXT",
        value: aValue
      };

      if(aName == "VALUE") {
        this.data.type = aValue;
        // TODO revalidate value
      }
    },

    countParameters: function countParmeters() {
      return(this.data.parameters ? Object.keys(this.data.parameters).length : 0);
    },

    removeParameter: function removeParameter(aName) {
      var ucName = aName.toUpperCase();
      if(ICAL.helpers.hasKey(this.data.parameters, ucName)) {
        delete this.data.parameters[ucName];
      }
    }
  };

  ICAL.icalproperty.fromData = function (aData) {
    return new ICAL.icalproperty(aData);
  };
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icalvalue = function icalvalue(aData, aParent, aType) {
    this.parent = aParent;
    this.fromData(aData, aType);
  };

  ICAL.icalvalue.prototype = {

    data: null,
    parent: null,
    icaltype: null,

    fromData: function icalvalue_fromData(aData, aType) {
      var type = (aType || (aData && aData.type) || this.icaltype);
      this.icaltype = type;

      if(aData && type) {
        aData.type = type
      }

      this.data = aData;
    },

    fromString: function icalvalue_fromString(aString, aType) {
      var type = aType || this.icaltype;
      this.fromData(ICAL.icalparser.parseValue(aString, type), type);
    },

    undecorate: function icalvalue_undecorate() {
      return this.toString();
    },

    toString: function () {
      return this.data.value.toString();
    }
  };

  ICAL.icalvalue.fromString = function icalvalue_fromString(aString, aType) {
    var val = new ICAL.icalvalue();
    val.fromString(aString, aType);
    return val;
  };

  ICAL.icalvalue._createFromString = function icalvalue__createFromString(ctor) {
    ctor.fromString = function icalvalue_derived_fromString(aStr) {
      var val = new ctor();
      val.fromString(aStr);
      return val;
    };
  };

  ICAL.icalbinary = function icalbinary(aData, aParent) {
    ICAL.icalvalue.call(this, aData, aParent, "BINARY");
  };

  ICAL.icalbinary.prototype = {

    __proto__: ICAL.icalvalue.prototype,

    icaltype: "BINARY",

    decodeValue: function decodeValue() {
      return this._b64_decode(this.data.value);
    },

    setEncodedValue: function setEncodedValue(val) {
      this.data.value = this._b64_encode(val);
    },

    _b64_encode: function base64_encode(data) {
      // http://kevin.vanzonneveld.net
      // +   original by: Tyler Akins (http://rumkin.com)
      // +   improved by: Bayron Guevara
      // +   improved by: Thunder.m
      // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
      // +   bugfixed by: Pellentesque Malesuada
      // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
      // +   improved by: Rafał Kukawski (http://kukawski.pl)
      // *     example 1: base64_encode('Kevin van Zonneveld');
      // *     returns 1: 'S2V2aW4gdmFuIFpvbm5ldmVsZA=='
      // mozilla has this native
      // - but breaks in 2.0.0.12!
      //if (typeof this.window['atob'] == 'function') {
      //    return atob(data);
      //}
      var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
      var o1, o2, o3, h1, h2, h3, h4, bits, i = 0,
        ac = 0,
        enc = "",
        tmp_arr = [];

      if(!data) {
        return data;
      }

      do { // pack three octets into four hexets
        o1 = data.charCodeAt(i++);
        o2 = data.charCodeAt(i++);
        o3 = data.charCodeAt(i++);

        bits = o1 << 16 | o2 << 8 | o3;

        h1 = bits >> 18 & 0x3f;
        h2 = bits >> 12 & 0x3f;
        h3 = bits >> 6 & 0x3f;
        h4 = bits & 0x3f;

        // use hexets to index into b64, and append result to encoded string
        tmp_arr[ac++] = b64.charAt(h1) + b64.charAt(h2) + b64.charAt(h3) + b64.charAt(h4);
      } while (i < data.length);

      enc = tmp_arr.join('');

      var r = data.length % 3;

      return(r ? enc.slice(0, r - 3) : enc) + '==='.slice(r || 3);

    },

    _b64_decode: function base64_decode(data) {
      // http://kevin.vanzonneveld.net
      // +   original by: Tyler Akins (http://rumkin.com)
      // +   improved by: Thunder.m
      // +      input by: Aman Gupta
      // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
      // +   bugfixed by: Onno Marsman
      // +   bugfixed by: Pellentesque Malesuada
      // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
      // +      input by: Brett Zamir (http://brett-zamir.me)
      // +   bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
      // *     example 1: base64_decode('S2V2aW4gdmFuIFpvbm5ldmVsZA==');
      // *     returns 1: 'Kevin van Zonneveld'
      // mozilla has this native
      // - but breaks in 2.0.0.12!
      //if (typeof this.window['btoa'] == 'function') {
      //    return btoa(data);
      //}
      var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
      var o1, o2, o3, h1, h2, h3, h4, bits, i = 0,
        ac = 0,
        dec = "",
        tmp_arr = [];

      if(!data) {
        return data;
      }

      data += '';

      do { // unpack four hexets into three octets using index points in b64
        h1 = b64.indexOf(data.charAt(i++));
        h2 = b64.indexOf(data.charAt(i++));
        h3 = b64.indexOf(data.charAt(i++));
        h4 = b64.indexOf(data.charAt(i++));

        bits = h1 << 18 | h2 << 12 | h3 << 6 | h4;

        o1 = bits >> 16 & 0xff;
        o2 = bits >> 8 & 0xff;
        o3 = bits & 0xff;

        if(h3 == 64) {
          tmp_arr[ac++] = String.fromCharCode(o1);
        } else if(h4 == 64) {
          tmp_arr[ac++] = String.fromCharCode(o1, o2);
        } else {
          tmp_arr[ac++] = String.fromCharCode(o1, o2, o3);
        }
      } while (i < data.length);

      dec = tmp_arr.join('');

      return dec;
    }
  };
  ICAL.icalvalue._createFromString(ICAL.icalbinary);

  ICAL.icalutcoffset = function icalutcoffset(aData, aParent) {
    ICAL.icalvalue.call(this, aData, aParent, "UTC-OFFSET");
  };

  ICAL.icalutcoffset.prototype = {

    __proto__: ICAL.icalvalue.prototype,

    hours: null,
    minutes: null,
    factor: null,

    icaltype: "UTC-OFFSET",

    fromData: function fromData(aData) {
      if(aData) {
        this.hours = aData.hours;
        this.minutes = aData.minutes;
        this.factor = aData.factor;
      }
    },

    toString: function toString() {
      return(this.factor == 1 ? "+" : "-") + ICAL.helpers.pad2(this.hours) + ICAL.helpers.pad2(this.minutes);
    }
  };
  ICAL.icalvalue._createFromString(ICAL.icalutcoffset);
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icalperiod = function icalperiod(aData) {
    this.wrappedJSObject = this;
    this.fromData(aData);
  };

  ICAL.icalperiod.prototype = {

    start: null,
    end: null,
    duration: null,
    icalclass: "icalperiod",
    icaltype: "PERIOD",

    getDuration: function duration() {
      if(this.duration) {
        return this.duration;
      } else {
        return this.end.subtractDate(this.start);
      }
    },

    toString: function toString() {
      return this.start + "/" + (this.end || this.duration);
    },

    fromData: function fromData(data) {
      if(data) {
        this.start = ("start" in data ? new ICAL.icaltime(data.start) : null);
        this.end = ("end" in data ? new ICAL.icaltime(data.end) : null);
        this.duration = ("duration" in data ? new ICAL.icalduration(data.duration) : null);
      }
    }
  };

  ICAL.icalperiod.fromString = function fromString(str) {
    var data = ICAL.icalparser.parseValue(str, "PERIOD");
    return ICAL.icalperiod.fromData(data);
  };
  ICAL.icalperiod.fromData = function fromData(aData) {
    return new ICAL.icalperiod(aData);
  };
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icalduration = function icalduration(data) {
    this.wrappedJSObject = this;
    this.fromData(data);
  };

  ICAL.icalduration.prototype = {

    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
    isNegative: false,
    icalclass: "icalduration",
    icaltype: "DURATION",

    clone: function clone() {
      return ICAL.icalduration.fromData(this);
    },

    toSeconds: function toSeconds() {
      var seconds = this.seconds + 60 * this.minutes + 3600 * this.hours + 86400 * this.days + 7 * 86400 * this.weeks;
      return(this.isNegative ? -seconds : seconds);
    },

    fromSeconds: function fromSeconds(aSeconds) {
      var secs = Math.abs(aSeconds);

      this.isNegative = (aSeconds < 0);
      this.days = ICAL.helpers.trunc(secs / 86400);

      // If we have a flat number of weeks, use them.
      if(this.days % 7 == 0) {
        this.weeks = this.days / 7;
        this.days = 0;
      } else {
        this.weeks = 0;
      }

      secs -= (this.days + 7 * this.weeks) * 86400;

      this.hours = ICAL.helpers.trunc(secs / 3600);
      secs -= this.hours * 3600;

      this.minutes = ICAL.helpers.trunc(secs / 60);
      secs -= this.minutes * 60;

      this.seconds = secs;
      return this;
    },

    fromData: function fromData(aData) {
      const propsToCopy = ["weeks", "days", "hours", "minutes", "seconds", "isNegative"];
      for each(var key in propsToCopy) {
        if(aData && key in aData) {
          this[key] = aData[key];
        } else {
          this[key] = 0;
        }
      }

      if(aData && "factor" in aData) {
        this.isNegative = (aData.factor == "-1");
      }
    },

    reset: function reset() {
      this.isNegative = false;
      this.weeks = 0;
      this.days = 0;
      this.hours = 0;
      this.minutes = 0;
      this.seconds = 0;
    },

    compare: function compare(aOther) {
      var thisSeconds = this.toSeconds();
      var otherSeconds = aOther.toSeconds();
      return(thisSeconds > otherSeconds) - (thisSeconds < otherSeconds);
    },

    normalize: function normalize() {
      this.fromSeconds(this.toSeconds());
      return this;
    },

    toString: function toString() {
      if(this.toSeconds() == 0) {
        return "PT0S";
      } else {
        var str = "";
        if(this.isNegative) str += "-";
        str += "P";
        if(this.weeks) str += this.weeks + "W";
        if(this.days) str += this.days + "D";

        if(this.hours || this.minutes || this.seconds) {
          str += "T";
          if(this.hours) str += this.hours + "H";
          if(this.minutes) str += this.minutes + "M";
          if(this.seconds) str += this.seconds + "S";
        }
        return str;
      }
    }
  };

  ICAL.icalduration.fromSeconds = function icalduration_from_seconds(aSeconds) {
    return(new ICAL.icalduration()).fromSeconds();
  };

  ICAL.icalduration.fromString = function icalduration_from_string(aStr) {
    var data = ICAL.icalparser.parseValue(aStr, "DURATION");
    return ICAL.icalduration.fromData(data);
  };

  ICAL.icalduration.fromData = function icalduration_from_data(aData) {
    return new ICAL.icalduration(aData);
  };
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icaltimezone = function icaltimezone(data) {
    this.wrappedJSObject = this;
    this.fromData(data);
  };

  ICAL.icaltimezone.prototype = {

    tzid: "",
    location: "",
    tznames: "",

    latitude: 0.0,
    longitude: 0.0,

    component: null,

    expand_end_year: 0,
    expand_start_year: 0,

    changes: null,
    icalclass: "icaltimezone",

    fromData: function fromData(aData) {
      const propsToCopy = ["tzid", "location", "tznames", "latitude", "longitude"];
      for each(var key in propsToCopy) {
        if(aData && key in aData) {
          this[key] = aData[key];
        } else {
          this[key] = 0;
        }
      }

      this.expand_end_year = 0;
      this.expand_start_year = 0;
      if(aData && "component" in aData) {
        if(typeof aData.component == "string") {
          this.component = this.componentFromString(aData.component);
        } else if(aData.component.icalclass == "icalcomponent") {
          this.component = aData.component.clone();
        } else {
          this.component = eval(aData.component.toSource());
        }
      } else {
        this.component = null;
      }
      return this;
    },

    componentFromString: function componentFromString(str) {
      this.component = ICAL.toJSON(str, true);
      return this.component;
    },

    utc_offset: function utc_offset(tt) {
      if(this == ICAL.icaltimezone.utc_timezone || this == ICAL.icaltimezone.local_timezone) {
        return 0;
      }

      this.ensure_coverage(tt.year);

      if(!this.changes || this.changes.length == 0) {
        return 0;
      }

      var tt_change = {
        year: tt.year,
        month: tt.month,
        day: tt.day,
        hour: tt.hour,
        minute: tt.minute,
        second: tt.second
      };

      var change_num = this.find_nearby_change(tt_change);
      var change_num_to_use = -1;
      var step = 1;

      for(;;) {
        var change = eval(this.changes[change_num].toSource()); // TODO clone
        if(change.utc_offset < change.prev_utc_offset) {
          ICAL.helpers.dumpn("Adjusting " + change.utc_offset);
          ICAL.icaltimezone.adjust_change(change, 0, 0, 0, change.utc_offset);
        } else {
          ICAL.helpers.dumpn("Adjusting prev " + change.prev_utc_offset);
          ICAL.icaltimezone.adjust_change(change, 0, 0, 0, change.prev_utc_offset);
        }

        var cmp = ICAL.icaltimezone._compare_change_fn(tt_change, change);
        ICAL.helpers.dumpn("Compare" + cmp + " / " + change.toSource());

        if(cmp >= 0) {
          change_num_to_use = change_num;
        } else {
          step = -1;
        }

        if(step == -1 && change_num_to_use != -1) {
          break;
        }

        change_num += step;

        if(change_num < 0) {
          return 0;
        }

        if(change_num >= this.changes.length) {
          break;
        }
      }

      var zone_change = this.changes[change_num_to_use];
      var utc_offset_change = zone_change.utc_offset - zone_change.prev_utc_offset;

      if(utc_offset_change < 0 && change_num_to_use > 0) {
        var tmp_change = eval(zone_change.toSource()); // TODO copy
        ICAL.icaltimezone.adjust_change(tmp_change, 0, 0, 0, tmp_change.prev_utc_offset);

        if(ICAL.icaltimezone._compare_change_fn(tt_change, tmp_change) < 0) {
          var prev_zone_change = this.changes[change_num_to_use - 1];

          var want_daylight = false; // TODO

          if(zone_change.is_daylight != want_daylight && prev_zone_change.is_daylight == want_daylight) {
            zone_change = prev_zone_change;
          }
        }
      }

      // TODO return is_daylight?
      return zone_change.utc_offset;
    },

    find_nearby_change: function icaltimezone_find_nearby_change(change) {
      var lower = 0,
        middle = 0;
      var upper = this.changes.length;

      while(lower < upper) {
        middle = ICAL.helpers.trunc(lower + upper / 2);
        var zone_change = this.changes[middle];
        var cmp = ICAL.icaltimezone._compare_change_fn(change, zone_change);
        if(cmp == 0) {
          break;
        } else if(cmp > 0) {
          upper = middle;
        } else {
          lower = middle;
        }
      }

      return middle;
    },

    ensure_coverage: function ensure_coverage(aYear) {
      if(ICAL.icaltimezone._minimum_expansion_year == -1) {
        var today = ICAL.icaltime.now();
        ICAL.icaltimezone._minimum_expansion_year = today.year;
      }

      var changes_end_year = aYear;
      if(changes_end_year < ICAL.icaltimezone._minimum_expansion_year) {
        changes_end_year = ICAL.icaltimezone._minimum_expansion_year;
      }

      changes_end_year += ICAL.icaltimezone.EXTRA_COVERAGE;

      if(changes_end_year > ICAL.icaltimezone.MAX_YEAR) {
        changes_end_year = ICAL.icaltimezone.MAX_YEAR;
      }

      if(!this.changes || this.expand_end_year < aYear) {
        this.expand_changes(changes_end_year);
      }
    },

    expand_changes: function expand_changes(aYear) {
      var changes = [];
      if(this.component) {
        // HACK checking for component only needed for floating tz, which
        // is not in core libical.
        for each(var comp in this.component.getAllSubcomponents()) {
          this.expand_vtimezone(comp, aYear, changes);
        }

        this.changes = changes.concat(this.changes || []);
        this.changes.sort(ICAL.icaltimezone._compare_change_fn);
      }

      this.change_end_year = aYear;
    },

    expand_vtimezone: function expand_vtimezone(aComponent, aYear, changes) {
      if(!aComponent.hasProperty("DTSTART") || !aComponent.hasProperty("TZOFFSETTO") || !aComponent.hasProperty("TZOFFSETFROM")) {
        return;
      }

      var dtstart = aComponent.getFirstProperty("DTSTART").getFirstValue();

      function convert_tzoffset(offset) {
        return offset.factor * (offset.hours * 3600 + offset.minutes * 60);
      }

      function init_changes() {
        var changebase = {};
        changebase.is_daylight = (aComponent.name == "DAYLIGHT");
        changebase.utc_offset = convert_tzoffset(aComponent.getFirstProperty("TZOFFSETTO").data);
        changebase.prev_utc_offset = convert_tzoffset(aComponent.getFirstProperty("TZOFFSETFROM").data);
        return changebase;
      }

      if(!aComponent.hasProperty("RRULE") && !aComponent.hasProperty("RDATE")) {
        var change = init_changes();
        change.year = dtstart.year;
        change.month = dtstart.month;
        change.day = dtstart.day;
        change.hour = dtstart.hour;
        change.minute = dtstart.minute;
        change.second = dtstart.second;

        ICAL.icaltimezone.adjust_change(change, 0, 0, 0, - change.prev_utc_offset);
        changes.push(change);
      } else {
        for each(var rdate in aComponent.getAllProperties("RDATE")) {
          var change = init_changes();
          change.year = rdate.time.year;
          change.month = rdate.time.month;
          change.day = rdate.time.day;

          if(rdate.time.isDate) {
            change.hour = dtstart.hour;
            change.minute = dtstart.minute;
            change.second = dtstart.second;
          } else {
            change.hour = rdate.time.hour;
            change.minute = rdate.time.minute;
            change.second = rdate.time.second;

            if(rdate.time.zone == ICAL.icaltimezone.utc_timezone) {
              ICAL.icaltimezone.adjust_change(change, 0, 0, 0, - change.prev_utc_offset);
            }
          }

          changes.push(change);
        }

        var rrule = aComponent.getFirstProperty("RRULE").getFirstValue();
        // TODO multiple rrules?

        var change = init_changes();

        if(rrule.until && rrule.until.zone == ICAL.icaltimezone.utc_timezone) {
          rrule.until.adjust(0, 0, 0, change.prev_utc_offset);
          rrule.until.zone = ICAL.icaltimezone.local_timezone;
        }

        var iterator = rrule.iterator(dtstart);

        var occ;
        while((occ = iterator.next())) {
          var change = init_changes();
          if(occ.year > aYear || !occ) {
            break;
          }

          change.year = occ.year;
          change.month = occ.month;
          change.day = occ.day;
          change.hour = occ.hour;
          change.minute = occ.minute;
          change.second = occ.second;
          change.isDate = occ.isDate;

          ICAL.icaltimezone.adjust_change(change, 0, 0, 0, - change.prev_utc_offset);
          changes.push(change);
        }
      }

      return changes;
    },

    toString: function toString() {
      return(this.tznames ? this.tznames : this.tzid);
    }

  };

  ICAL.icaltimezone._compare_change_fn = function icaltimezone_compare_change_fn(a, b) {
    if(a.year < b.year) return -1;
    else if(a.year > b.year) return 1;

    if(a.month < b.month) return -1;
    else if(a.month > b.month) return 1;

    if(a.day < b.day) return -1;
    else if(a.day > b.day) return 1;

    if(a.hour < b.hour) return -1;
    else if(a.hour > b.hour) return 1;

    if(a.minute < b.minute) return -1;
    else if(a.minute > b.minute) return 1;

    if(a.second < b.second) return -1;
    else if(a.second > b.second) return 1;

    return 0;
  };

  ICAL.icaltimezone.convert_time = function icaltimezone_convert_time(tt, from_zone, to_zone) {
    if(tt.isDate || from_zone.tzid == to_zone.tzid || from_zone == ICAL.icaltimezone.local_timezone || to_zone == ICAL.icaltimezone.local_timezone) {
      tt.zone = to_zone;
      return tt;
    }

    var utc_offset = from_zone.utc_offset(tt);
    tt.adjust(0, 0, 0, - utc_offset);

    utc_offset = to_zone.utc_offset(tt);
    tt.adjust(0, 0, 0, utc_offset);
  };

  ICAL.icaltimezone.fromData = function icaltimezone_fromData(aData) {
    var tt = new ICAL.icaltimezone();
    return tt.fromData(aData);
  };

  ICAL.icaltimezone.utc_timezone = ICAL.icaltimezone.fromData({
    tzid: "UTC"
  });
  ICAL.icaltimezone.local_timezone = ICAL.icaltimezone.fromData({
    tzid: "floating"
  });

  ICAL.icaltimezone.adjust_change = function icaltimezone_adjust_change(change, days, hours, minutes, seconds) {
    return ICAL.icaltime.prototype.adjust.call(change, days, hours, minutes, seconds);
  };

  ICAL.icaltimezone._minimum_expansion_year = -1;
  ICAL.icaltimezone.MAX_YEAR = 2035; // TODO this is because of time_t, which we don't need. Still usefull?
  ICAL.icaltimezone.EXTRA_COVERAGE = 5;
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icalrecur = function icalrecur(data) {
    this.wrappedJSObject = this;
    this.parts = {};
    this.fromData(data);
  };

  ICAL.icalrecur.prototype = {

    parts: null,

    interval: 1,
    wkst: 1,
    until: null,
    count: null,
    freq: null,
    icalclass: "icalrecur",
    icaltype: "RECUR",

    iterator: function (aStart) {
      return new icalrecur_iterator(this, aStart);
    },

    clone: function clone() {
      return ICAL.icalrecur.fromData(this);
      //return ICAL.icalrecur.fromIcalProperty(this.toIcalProperty());
    },

    is_finite: function isfinite() {
      return(this.count || this.until);
    },

    is_by_count: function isbycount() {
      return(this.count && !this.until);
    },

    addComponent: function addPart(aType, aValue) {
      if(!(aType in this.parts)) {
        this.parts[aType] = [aValue];
      } else {
        this.parts[aType].push(aValue);
      }
    },

    setComponent: function setComponent(aType, aValues) {
      this.parts[aType] = aValues;
    },

    getComponent: function getComponent(aType, aCount) {
      var ucName = aType.toUpperCase();
      var components = (ucName in this.parts ? this.parts[ucName] : []);

      if(aCount) aCount.value = components.length;
      return components;
    },

    getNextOccurrence: function getNextOccurrence(aStartTime, aRecurrenceId) {
      ICAL.helpers.dumpn("GNO: " + aRecurrenceId + " / " + aStartTime);
      var iter = this.iterator(aStartTime);
      var next, cdt;

      do {
        next = iter.next();
        ICAL.helpers.dumpn("Checking " + next + " <= " + aRecurrenceId);
      } while (next && next.compare(aRecurrenceId) <= 0);

      if(next && aRecurrenceId.zone) {
        next.zone = aRecurrenceId.zone;
      }

      return next;
    },

    fromData: function fromData(aData) {
      const propsToCopy = ["freq", "count", "wkst", "interval"];
      for each(var key in propsToCopy) {
        if(aData && key.toUpperCase() in aData) {
          this[key] = aData[key.toUpperCase()];
          // TODO casing sucks, fix the parser!
        } else if(aData && key in aData) {
          this[key] = aData[key];
          // TODO casing sucks, fix the parser!
        }
      }

      if(aData && "until" in aData && aData.until) {
        this.until = aData.until.clone();
      }

      const partsToCopy = ["BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS"]
      this.parts = {};
      if(aData) {
        for each(var key in partsToCopy) {
          if(key in aData) {
            this.parts[key] = aData[key];
            // TODO casing sucks, fix the parser!
          }
        }
        // TODO oh god, make it go away!
        if(aData.parts) {
          for each(var key in partsToCopy) {
            if(key in aData.parts) {
              this.parts[key] = aData.parts[key];
              // TODO casing sucks, fix the parser!
            }
          }
        }
      }
      return this;
    },

    toString: function icalrecur_toString() {
      // TODO retain order
      var str = "FREQ=" + this.freq;
      if(this.count) {
        str += ";COUNT=" + this.count;
      }
      if(this.interval != 1) {
        str += ";INTERVAL=" + this.interval;
      }
      str += [";" + k + "=" + this.parts[k]
      for(k in this.parts)].join("");
      return str;
    },

    toIcalProperty: function toIcalProperty() {
      try {
        var valueData = {
          name: this.isNegative ? "EXRULE" : "RRULE",
          type: "RECUR",
          value: [this.toString()],
          // TODO more props?
        };
        return ICAL.icalproperty.fromData(valueData);
      } catch(e) {
        ICAL.helpers.dumpn("EICALPROP: " + this.toString() + "//" + e);
        ICAL.helpers.dumpn(e.stack);
      }
    },
    fromIcalProperty: function fromIcalProperty(aProp) {
      var propval = aProp.getFirstValue();
      this.fromData(propval);
      this.parts = eval(propval.parts.toSource());
      if(aProp.name == "EXRULE") {
        this.isNegative = true;
      } else if(aProp.name == "RRULE") {
        this.isNegative = false;
      } else {
        throw new Error("Invalid Property " + aProp.name + " passed");
      }
    },
  };

  ICAL.icalrecur.fromData = function icalrecur_fromData(data) {
    return(new ICAL.icalrecur(data));
  }

  ICAL.icalrecur.fromString = function icalrecur_fromString(str) {
    var data = ICAL.icalparser.parseValue(str, "RECUR");
    return ICAL.icalrecur.fromData(data);
  };

  ICAL.icalrecur.fromIcalProperty = function icalrecur_fromIcalProperty(prop) {
    var recur = new ICAL.icalrecur();
    recur.fromIcalProperty(prop);
    return recur;
  };

  function icalrecur_iterator(aRule, aStart) {
    this.rule = aRule;
    this.dtstart = aStart;
    this.by_data = eval(aRule.parts.toSource());
    this.days = [];
    this.init();
  }

  icalrecur_iterator.prototype = {

    rule: null,
    dtstart: null,
    last: null,
    occurrence_number: 0,
    by_indices: null,
    by_data: null,

    days: null,
    days_index: 0,

    init: function icalrecur_iterator_init() {
      this.last = this.dtstart.clone();
      var parts = this.by_data;

      this.by_indices = {
        "BYSECOND": 0,
        "BYMINUTE": 0,
        "BYHOUR": 0,
        "BYDAY": 0,
        "BYMONTH": 0,
        "BYWEEKNO": 0,
        "BYMONTHDAY": 0,
      };

      // If the BYYEARDAY appares, no other date rule part may appear
      if("BYYEARDAY" in parts) {
        if("BYMONTH" in parts || "BYWEEKNO" in parts || "BYMONTHDAY" in parts || "BYDAY" in parts) {
          throw new Error("Invalid BYYEARDAY rule");
        }
      }

      // BYWEEKNO and BYMONTHDAY rule parts may not both appear
      if("BYWEEKNO" in parts && "BYMONTHDAY" in parts) {
        throw new Error("BYWEEKNO does not fit to BYMONTHDAY");
      }

      // For MONTHLY recurrences (FREQ=MONTHLY) neither BYYEARDAY nor
      // BYWEEKNO may appear.
      if(this.rule.freq == "MONTHLY" && ("BYYEARDAY" in parts || "BYWEEKNO" in parts)) {
        throw new Error("For MONTHLY recurrences neither BYYEARDAY nor BYWEEKNO may appear");
      }

      // For WEEKLY recurrences (FREQ=WEEKLY) neither BYMONTHDAY nor
      // BYYEARDAY may appear.
      if(this.rule.freq == "WEEKLY" && ("BYYEARDAY" in parts || "BYMONTHDAY" in parts)) {
        throw new Error("For WEEKLY recurrences neither BYMONTHDAY nor BYYEARDAY may appear");
      }

      // BYYEARDAY may only appear in YEARLY rules
      if(this.rule.freq != "YEARLY" && "BYYEARDAY" in parts) {
        throw new Error("BYYEARDAY may only appear in YEARLY rules");
      }

      this.last.second = this.setup_defaults("BYSECOND", "SECONDLY", this.dtstart.second);
      this.last.minute = this.setup_defaults("BYMINUTE", "MINUTELY", this.dtstart.minute);
      this.last.hour = this.setup_defaults("BYHOUR", "HOURLY", this.dtstart.hour);
      this.last.day = this.setup_defaults("BYMONTHDAY", "DAILY", this.dtstart.day);
      this.last.month = this.setup_defaults("BYMONTH", "MONTHLY", this.dtstart.month);

      if(this.rule.freq == "WEEKLY") {
        if("BYDAY" in parts) {
          var [pos, rule_dow] = this.rule_day_of_week(parts.BYDAY[0]);
          var dow = rule_dow - this.last.day_of_week();
          if((this.last.day_of_week() < rule_dow && dow >= 0) || dow < 0) {
            // Initial time is after first day of BYDAY data
            this.last.day += dow;
            this.last.normalize();
          }
        } else {
          parts.BYDAY = [icalrecur_iterator._wkdayMap[this.dtstart.day_of_week()]];
        }
      }

      if(this.rule.freq == "YEARLY") {
        for(;;) {
          this.expand_year_days(this.last.year);
          if(this.days.length > 0) {
            break;
          }
          this.increment_year(this.rule.interval);
        }

        var next = ICAL.icaltime.from_day_of_year(this.days[0], this.last.year);

        this.last.day = next.day;
        this.last.month = next.month;
      }

      if(this.rule.freq == "MONTHLY" && this.has_by_data("BYDAY")) {
        var [pos, dow] = this.rule_day_of_week(this.by_data.BYDAY[this.by_indices.BYDAY]);

        var days_in_month = ICAL.icaltime.days_in_month(this.last.month, this.last.year);
        var poscount = 0;

        if(pos >= 0) {
          for(this.last.day = 1; this.last.day <= days_in_month; this.last.day++) {
            if(this.last.day_of_week() == dow) {
              if(++poscount == pos || pos == 0) {
                break;
              }
            }
          }
        } else {
          pos = -pos;
          for(this.last.day = days_in_month; this.last.day != 0; this.last.day--) {
            if(this.last.day_of_week() == dow) {
              if(++poscount == pos) {
                break;
              }
            }
          }
        }

        if(this.last.day > days_in_month || this.last.day == 0) {
          throw new Error("Malformed values in BYDAY part");
        }

      } else if(this.has_by_data("BYMONTHDAY")) {
        if(this.last.day < 0) {
          var days_in_month = ICAL.icaltime.days_in_month(this.last.month, this.last.year);
          this.last.day = days_in_month + this.last.day + 1;
        }

        this.last.normalize();
      }
    },

    next: function icalrecur_iterator_next() {
      var before = (this.last ? this.last.clone() : null);

      if((this.rule.count && this.occurrence_number >= this.rule.count) || (this.rule.until && this.last.compare(this.rule.until) > 0)) {
        return null;
      }

      if(this.occurrence_number == 0 && this.last.compare(this.dtstart) >= 0) {
        // First of all, give the instance that was initialized
        this.occurrence_number++;
        return this.last;
      }

      do {
        var valid = 1;

        switch(this.rule.freq) {
        case "SECONDLY":
          this.next_second();
          break;
        case "MINUTELY":
          this.next_minute();
          break;
        case "HOURLY":
          this.next_hour();
          break;
        case "DAILY":
          this.next_day();
          break;

        case "WEEKLY":
          this.next_week();
          break;
        case "MONTHLY":
          valid = this.next_month();
          break;
        case "YEARLY":
          this.next_year();
          break;

        default:
          return null;
        }
      } while (!this.check_contracting_rules() || this.last.compare(this.dtstart) < 0 || !valid);

      // TODO is this valid?
      if(this.last.compare(before) == 0) {
        throw new Error("Same occurrence found twice, protecting " + " you from death by recursion");
      }

      if(this.rule.until && this.last.compare(this.rule.until) > 0) {
        return null;
      } else {
        this.occurrence_number++;
        return this.last;
      }
    },

    next_second: function next_second() {
      return this.next_generic("BYSECOND", "SECONDLY", "second", "minute");
    },

    increment_second: function increment_second(inc) {
      return this.increment_generic(inc, "second", 60, "minute");
    },

    next_minute: function next_minute() {
      return this.next_generic("BYMINUTE", "MINUTELY", "minute", "hour", "next_second");
    },

    increment_minute: function increment_minute(inc) {
      return this.increment_generic(inc, "minute", 60, "hour");
    },

    next_hour: function next_hour() {
      return this.next_generic("BYHOUR", "HOURLY", "hour", "monthday", "next_minute");
    },

    increment_hour: function increment_hour(inc) {
      this.increment_generic(inc, "hour", 24, "monthday");
    },

    next_day: function next_day() {
      var has_by_day = ("BYDAY" in this.by_data);
      var this_freq = (this.rule.freq == "DAILY");

      if(this.next_hour() == 0) {
        return 0;
      }

      if(this_freq) {
        this.increment_monthday(this.rule.interval);
      } else {
        this.increment_monthday(1);
      }

      return 0;
    },

    next_week: function next_week() {
      var end_of_data = 0;

      if(this.next_weekday_by_week() == 0) {
        return end_of_data;
      }

      if(this.has_by_data("BYWEEKNO")) {
        var idx = ++this.by_indices.BYWEEKNO;

        if(this.by_indices.BYWEEKNO == this.by_data.BYWEEKNO.length) {
          this.by_indices.BYWEEKNO = 0;
          end_of_data = 1;
        }

        // HACK should be first month of the year
        this.last.month = 1;
        this.last.day = 1;

        var week_no = this.by_data.BYWEEKNO[this.by_indices.BYWEEKNO];

        this.last.day += 7 * week_no;
        this.last.normalize();

        if(end_of_data) {
          this.increment_year(1)
        }
      } else {
        // Jump to the next week
        this.increment_monthday(7 * this.rule.interval);
      }

      return end_of_data;
    },

    next_month: function next_month() {
      var this_freq = (this.rule.freq == "MONTHLY");
      var data_valid = 1;

      if(this.next_hour() == 0) {
        return data_valid;
      }

      if(this.has_by_data("BYDAY") && this.has_by_data("BYMONTHDAY")) {
        var days_in_month = ICAL.icaltime.days_in_month(this.last.month, this.last.year);
        var notFound = true;
        var day;

        for(day = last.day + 1; notFound && day <= days_in_month; day++) {
          for(var dayIdx = 0; dayIdx < this.by_data.BYDAY.length; dayIdx++) {
            for(var mdIdx = 0; mdIdx < this.by_data.BYMONTHDAY.length; mdIdx++) {
              var [pos, dow] = this.rule_day_of_week(this.by_data.BYDAY[dayIdx]);
              var mday = this.by_data.BYMONTHDAY[mdIdx];

              this.last.day = day;
              var this_dow = this.last.day_of_week();

              if((pos == 0 && dow == this_dow && mday == day) || (this.last.nth_weekday(dow, pos))) {
                notFound = false;
              }
            }
          }
        }
        if(day > days_in_month) {
          this.last.day = 1;
          this.increment_month();
          this.last.day--;
          data_valid = 0;
        }

      } else if(this.has_by_data("BYDAY")) {
        var days_in_month = ICAL.icaltime.days_in_month(this.last.month, this.last.year);
        var setpos = 0;

        if(this.has_by_data("BYSETPOS")) {
          var lastday = this.last.day;
          for(var day = 1; day <= days_in_month; day++) {
            this.last.day = day;
            if(this.is_day_in_byday(this.last) && day <= last_day) {
              setpos++
            }
          }
          this.last.day = last_day;
        }

        for(var day = this.last.day + 1; day <= days_in_month; day++) {
          this.last.day = day;

          if(this.is_day_in_byday(this.last)) {
            if(!this.has_by_data("BYSETPOS") || this.check_set_position(++setpos) || this.check_set_position(setpos - this.by_data.BYSETPOS.length - 1)) {
              found = 1;
              break;
            }
          }
        }

        data_valid = found;

        if(day > days_in_month) {
          this.last.day = 1;
          this.increment_month();

          if(this.is_day_in_byday(this.last)) {
            if(!this.has_by_data("BYSETPOS") || this.check_set_position(1)) {
              data_valid = 1;
            }
          } else {
            data_valid = 0;
          }
        }
      } else if(this.has_by_data("BYMONTHDAY")) {
        this.by_indices.BYMONTHDAY++;

        if(this.by_indices.BYMONTHDAY >= this.by_data.BYMONTHDAY.length) {
          this.by_indices.BYMONTHDAY = 0;
          this.increment_month();
        }

        var days_in_month = ICAL.icaltime.days_in_month(this.last.month, this.last.year);

        var day = this.by_data.BYMONTHDAY[this.by_indices.BYMONTHDAY];

        if(day < 0) {
          day = days_in_month + day + 1;
        }

        if(day > days_in_month) {
          this.last.day = 1;
          data_valid = this.is_day_in_byday(this.last);
        }

        this.last.day = day;
      } else {
        this.last.day = this.by_data.BYMONTHDAY[0];
        this.increment_month();
        var days_in_month = ICAL.icaltime.days_in_month(this.last.month, this.last.year);
        this.last.day = Math.min(this.last.day, days_in_month);
      }

      return data_valid;
    },

    next_weekday_by_week: function next_weekday_by_week() {
      var end_of_data = 0;

      if(this.next_hour() == 0) {
        return end_of_data;
      }

      if(!this.has_by_data("BYDAY")) {
        return 1;
      }

      //this.sort_byday_rules(this.by_data.BYDAY, this.rule.wkst);

      for(;;) {
        var tt = new ICAL.icaltime();
        tt.auto_normalize = false;
        this.by_indices.BYDAY++;

        if(this.by_indices.BYDAY == this.by_data.BYDAY.length) {
          this.by_indices.BYDAY = 0;
          end_of_data = 1;
        }

        var [, dow] = this.rule_day_of_week(this.by_data.BYDAY[this.by_indices.BYDAY]);
        dow -= this.rule.wkst;
        if(dow < 0) {
          dow += 7;
        }

        tt.year = this.last.year;
        tt.month = this.last.month;
        tt.day = this.last.day;

        var start_of_week = tt.start_doy_week(this.rule.wkst);

        if(dow + start_of_week < 1) {
          // The selected date is in the previous year
          if(!end_of_data) {
            continue;
          }
        }

        var next = ICAL.icaltime.from_day_of_year(start_of_week + dow, this.last.year);

        this.last.day = next.day;
        this.last.month = next.month;
        this.last.year = next.year;

        return end_of_data;
      }
    },

    next_year: function next_year() {

      if(this.next_hour() == 0) {
        return 0;
      }

      if(++this.days_index == this.days.length) {
        this.days_index = 0;
        do {
          this.increment_year(this.rule.interval);
          this.expand_year_days(this.last.year);
        } while (this.days.length == 0);
      }

      var next = ICAL.icaltime.from_day_of_year(this.days[this.days_index], this.last.year);

      this.last.day = next.day;
      this.last.month = next.month;

      return 1;
    },

    rule_day_of_week: function rule_day_of_week(dow) {
      const dowMap = {
        SU: 1,
        MO: 2,
        TU: 3,
        WE: 4,
        TH: 5,
        FR: 6,
        SA: 7
      };
      var matches = dow.match(/([+-]?[0-9])?(MO|TU|WE|TH|FR|SA|SU)/);
      return(matches ? [parseInt(matches[1] || 0, 10), dowMap[matches[2]]] || 0 : [0, 0]);
    },

    next_generic: function next_generic(aRuleType, aInterval, aDateAttr, aFollowingAttr, aPreviousIncr) {
      var has_by_rule = (aRuleType in this.by_data);
      var this_freq = (this.rule.freq == aInterval);
      var end_of_data = 0;

      if(aPreviousIncr && this[aPreviousIncr]() == 0) {
        return end_of_data;
      }

      if(has_by_rule) {
        this.by_indices[aRuleType]++;
        var idx = this.by_indices[aRuleType];

        if(this.by_indices[aRuleType] == this.by_data[aRuleType].length) {
          this.by_indices[aRuleType] = 0;
          end_of_data = 1;
        }
        this.last[aDateAttr] = this.by_data[aRuleType][this.by_indices[aRuleType]];
      } else if(this_freq) {
        this["increment_" + aDateAttr](this.rule.interval);
      }

      if(has_by_rule && end_of_data && this_freq) {
        this["increment_" + aFollowingAttr](1);
      }

      return end_of_data;
    },

    increment_monthday: function increment_monthday(inc) {
      for(var i = 0; i < inc; i++) {
        var days_in_month = ICAL.icaltime.days_in_month(this.last.month, this.last.year);
        this.last.day++;

        if(this.last.day > days_in_month) {
          this.last.day -= days_in_month;
          this.increment_month();
        }
      }
    },

    increment_month: function increment_month() {
      if(this.has_by_data("BYMONTH")) {
        this.by_indices.BYMONTH++;

        if(this.by_indices.BYMONTH == this.by_data.BYMONTH.length) {
          this.by_indices.BYMONTH = 0;
          this.increment_year(1);
        }

        this.last.month = this.by_data.BYMONTH[this.by_indices.BYMONTH];
      } else {
        var inc;
        if(this.rule.freq == "MONTHLY") {
          this.last.month += this.rule.interval;
        } else {
          this.last.month++;
        }

        this.last.month--;
        var years = ICAL.helpers.trunc(this.last.month / 12);
        this.last.month %= 12;
        this.last.month++;

        if(years != 0) {
          this.increment_year(years);
        }
      }
    },

    increment_year: function increment_year(inc) {
      this.last.year += inc;
    },

    increment_generic: function increment_generic(inc, aDateAttr, aFactor, aNextIncrement) {
      this.last[aDateAttr] += inc;
      var nextunit = ICAL.helpers.trunc(this.last[aDateAttr] / aFactor);
      this.last[aDateAttr] %= aFactor;
      if(nextunit != 0) {
        this["increment_" + aNextIncrement](nextunit);
      }
    },

    has_by_data: function has_by_data(aRuleType) {
      return(aRuleType in this.rule.parts);
    },

    expand_year_days: function expand_year_days(aYear) {
      var t = new ICAL.icaltime();
      this.days = [];

      // We need our own copy with a few keys set
      var parts = {};
      for each(var p in ["BYDAY", "BYWEEKNO", "BYMONTHDAY", "BYMONTH", "BYYEARDAY"]) {
        if(p in this.rule.parts) {
          parts[p] = this.rule.parts[p];
        }
      }

      if("BYMONTH" in parts && "BYWEEKNO" in parts) {
        var valid = 1;
        var validWeeks = {};
        t.year = aYear;
        t.isDate = true;

        for(var monthIdx = 0; monthIdx < this.by_data.BYMONTH.length; monthIdx++) {
          var month = this.by_data.BYMONTH[monthIdx];
          t.month = month;
          t.day = 1;
          var first_week = t.week_number(this.rule.wkst);
          t.day = ICAL.icaltime.days_in_month(month, aYear);
          var last_week = t.week_number(this.rule.wkst);
          for(monthIdx = first_week; monthIdx < last_week; monthIdx++) {
            validWeeks[monthIdx] = 1;
          }
        }

        for(var weekIdx = 0; weekIdx < this.by_data.BYWEEKNO.length && valid; weekIdx++) {
          var weekno = this.by_data.BYWEEKNO[weekIdx];
          if(weekno < 52) {
            valid &= validWeeks[weekIdx];
          } else {
            valid = 0;
          }
        }

        if(valid) {
          delete parts.BYMONTH;
        } else {
          delete parts.BYWEEKNO;
        }
      }

      var partCount = Object.keys(parts).length;

      if(partCount == 0) {
        var t = this.dtstart.clone();
        t.year = this.last.year;
        this.days.push(t.day_of_year());
      } else if(partCount == 1 && "BYMONTH" in parts) {
        for each(var month in this.by_data.BYMONTH) {
          var t2 = this.dtstart.clone();
          t2.year = aYear;
          t2.month = month;
          t2.isDate = true;
          this.days.push(t2.day_of_year());
        }
      } else if(partCount == 1 && "BYMONTHDAY" in parts) {
        for each(var month_day in this.by_data.BYMONTHDAY) {
          var t2 = this.dtstart.clone();
          t2.day = month_day;
          t2.year = aYear;
          t2.isDate = true;
          this.days.push(t2.day_of_year());
        }
      } else if(partCount == 2 && "BYMONTHDAY" in parts && "BYMONTH" in parts) {
        for each(var month in this.by_data.BYMONTH) {
          for each(var monthDay in this.by_data.BYMONTHDAY) {
            t.day = monthDay;
            t.month = month;
            t.year = aYear;
            t.isDate = true;

            this.days.push(t.day_of_year());
          }
        }
      } else if(partCount == 1 && "BYWEEKNO" in parts) {
        // TODO unimplemented in libical
      } else if(partCount == 2 && "BYWEEKNO" in parts && "BYMONTHDAY" in parts) {
        // TODO unimplemented in libical
      } else if(partCount == 1 && "BYDAY" in parts) {
        this.days = this.days.concat(this.expand_by_day(aYear));
      } else if(partCount == 2 && "BYDAY" in parts && "BYMONTH" in parts) {
        for each(var month in this.by_data.BYMONTH) {
          var days_in_month = ICAL.icaltime.days_in_month(month, aYear);

          t.year = aYear;
          t.month = month;
          t.day = 1;
          t.isDate = true;

          var first_dow = t.day_of_week();
          var doy_offset = t.day_of_year() - 1;

          t.day = days_in_month;
          var last_dow = t.day_of_week();

          if(this.has_by_data("BYSETPOS")) {
            var set_pos_counter = 0;
            var by_month_day = [];
            for(var day = 1; day <= days_in_month; day++) {
              t.day = day;
              if(this.is_day_in_byday(t)) {
                by_month_day.push(day);
              }
            }

            for(var spIndex = 0; spIndex < by_month_day.length; spIndex++) {
              if(this.check_set_position(spIndex + 1) || this.check_set_position(spIndex - by_month_day.length)) {
                this.days.push(doy_offset + by_month_day[spIndex]);
              }
            }
          } else {
            for each(var day_coded in this.by_data.BYDAY) {
              var [dow, pos] = this.rule_day_of_week(day_coded);

              var first_matching_day = ((dow + 7 - first_dow) % 7) + 1;
              var last_matching_day = days_in_month - ((last_dow + 7 - dow) % 7);

              if(pos == 0) {
                for(var day = first_matching_day; day <= days_in_month; day += 7) {
                  this.days.push(doy_offset + day);
                }
              } else if(pos > 0) {
                month_day = first_matching_day + (pos - 1) * 7;

                if(month_day <= days_in_month) {
                  this.days.push(doy_offset + month_day);
                }
              } else {
                month_day = last_matching_day + (pos + 1) * 7;

                if(month_day > 0) {
                  this.days.push(doy_offset + month_day);
                }
              }
            }
          }
        }
      } else if(partCount == 2 && "BYDAY" in parts && "BYMONTHDAY" in parts) {
        var expandedDays = this.expand_by_day(aYear);

        for each(var day in expandedDays) {
          var tt = ICAL.icaltime.from_day_of_year(day, aYear);
          if(this.by_data.BYMONTHDAY.indexOf(tt.day) >= 0) {
            this.days.push(day);
          }
        }
      } else if(partCount == 3 && "BYDAY" in parts && "BYMONTHDAY" in parts && "BYMONTH" in parts) {
        var expandedDays = this.expand_by_day(aYear);

        for each(var day in expandedDays) {
          var tt = ICAL.icaltime.from_day_of_year(day, aYear);

          if(this.by_data.BYMONTH.indexOf(tt.month) >= 0 && this.by_data.BYMONTHDAY.indexOf(tt.day) >= 0) {
            this.days.push(day);
          }
        }
      } else if(partCount == 2 && "BYDAY" in parts && "BYWEEKNO" in parts) {
        var expandedDays = this.expand_by_day(aYear);

        for each(var day in expandedDays) {
          var tt = ICAL.icaltime.from_day_of_year(day, aYear);
          var weekno = tt.week_number(this.rule.wkst);

          if(this.by_data.BYWEEKNO.indexOf(weekno)) {
            this.days.push(day);
          }
        }
      } else if(partCount == 3 && "BYDAY" in parts && "BYWEEKNO" in parts && "BYMONTHDAY" in parts) {
        // TODO unimplemted in libical
      } else if(partCount == 1 && "BYYEARDAY" in parts) {
        this.days = this.days.concat(this.by_data.BYYEARDAY);
      } else {
        this.days = [];
      }
      return 0;
    },

    expand_by_day: function expand_by_day(aYear) {

      var days_list = [];
      var tmp = this.last.clone();

      tmp.year = aYear;
      tmp.month = 1;
      tmp.day = 1;
      tmp.isDate = true;

      var start_dow = tmp.day_of_week();

      tmp.month = 12;
      tmp.day = 31;
      tmp.isDate = true;

      var end_dow = tmp.day_of_week();
      var end_year_day = tmp.day_of_year();

      for each(var day in this.by_data.BYDAY) {
        var [pos, dow] = this.rule_day_of_week(day);

        if(pos == 0) {
          var tmp_start_doy = ((dow + 7 - start_dow) % 7) + 1;

          for(var doy = tmp_start_doy; doy <= end_year_day; doy += 7) {
            days_list.push(doy);
          }

        } else if(pos > 0) {
          var first;
          if(dow >= start_dow) {
            first = dow - start_dow + 1;
          } else {
            first = dow - start_dow + 8;
          }

          days_list.push(first + (pos - 1) * 7);
        } else {
          var last;
          pos = -pos;

          if(dow <= end_dow) {
            last = end_year_day - end_dow + dow;
          } else {
            last = end_year_day - end_dow + dow - 7;
          }

          days_list.push(last - (pos - 1) * 7);
        }
      }
      return days_list;
    },

    is_day_in_byday: function is_day_in_byday(tt) {
      for each(var day in this.by_data.BYDAY) {
        var [pos, dow] = this.rule_day_of_week(day);
        var this_dow = tt.day_of_week();

        if((pos == 0 && dow == this_dow) || (tt.nth_weekday(dow, pos) == tt.day)) {
          return 1;
        }
      }

      return 0;
    },

    check_set_position: function check_set_position(aPos) {
      return("BYSETPOS" in this.by_data && this.by_data.BYSETPOS.indexOf(aPos));
    },

    sort_byday_rules: function icalrecur_sort_byday_rules(aRules, aWeekStart) {
      for(var i = 0; i < aRules.length; i++) {
        for(var j = 0; j < i; j++) {
          var [, one] = this.rule_day_of_week(aRules[j]);
          var [, two] = this.rule_day_of_week(aRules[i]);
          one -= aWeekStart;
          two -= aWeekStart;
          if(one < 0) one += 7;
          if(two < 0) two += 7;

          if(one > two) {
            var tmp = aRules[i];
            aRules[i] = aRules[j];
            aRules[j] = tmp;
          }
        }
      }
    },

    check_contract_restriction: function check_contract_restriction(aRuleType, v) {
      var indexMapValue = icalrecur_iterator._indexMap[aRuleType];
      var ruleMapValue = icalrecur_iterator._expandMap[this.rule.freq][indexMapValue];
      var pass = false;

      if(aRuleType in this.by_data && ruleMapValue == icalrecur_iterator.CONTRACT) {
        for each(var bydata in this.by_data[aRuleType]) {
          if(bydata == v) {
            pass = true;
            break;
          }
        }
      } else {
        // Not a contracting byrule or has no data, test passes
        pass = true;
      }
      return pass;
    },

    check_contracting_rules: function check_contracting_rules() {
      var dow = this.last.day_of_week()
      var weekNo = this.last.week_number(this.rule.wkst);
      var doy = this.last.day_of_year();

      return(this.check_contract_restriction("BYSECOND", this.last.second) && this.check_contract_restriction("BYMINUTE", this.last.minute) && this.check_contract_restriction("BYHOUR", this.last.hour) && this.check_contract_restriction("BYDAY", dow) && this.check_contract_restriction("BYWEEKNO", weekNo) && this.check_contract_restriction("BYMONTHDAY", this.last.day) && this.check_contract_restriction("BYMONTH", this.last.month) && this.check_contract_restriction("BYYEARDAY", doy));
    },

    setup_defaults: function setup_defaults(aRuleType, req, deftime) {
      var indexMapValue = icalrecur_iterator._indexMap[aRuleType];
      var ruleMapValue = icalrecur_iterator._expandMap[this.rule.freq][indexMapValue];

      if(ruleMapValue != icalrecur_iterator.CONTRACT) {
        if(!(aRuleType in this.by_data)) {
          this.by_data[aRuleType] = [deftime];
        }
        if(this.rule.freq != req) {
          return this.by_data[aRuleType][0];
        }
      }
      return deftime;
    },
  };

  icalrecur_iterator._wkdayMap = ["", "SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  icalrecur_iterator._indexMap = {
    "BYSECOND": 0,
    "BYMINUTE": 1,
    "BYHOUR": 2,
    "BYDAY": 3,
    "BYMONTHDAY": 4,
    "BYYEARDAY": 5,
    "BYWEEKNO": 6,
    "BYMONTH": 7,
    "BYSETPOS": 8
  };

  icalrecur_iterator._expandMap = {
    "SECONDLY": [1, 1, 1, 1, 1, 1, 1, 1],
    "MINUTELY": [2, 1, 1, 1, 1, 1, 1, 1],
    "HOURLY": [2, 2, 1, 1, 1, 1, 1, 1],
    "DAILY": [2, 2, 2, 1, 1, 1, 1, 1],
    "WEEKLY": [2, 2, 2, 2, 3, 3, 1, 1],
    "MONTHLY": [2, 2, 2, 2, 2, 3, 3, 1],
    "YEARLY": [2, 2, 2, 2, 2, 2, 2, 2]
  };
  icalrecur_iterator.UNKNOWN = 0;
  icalrecur_iterator.CONTRACT = 1;
  icalrecur_iterator.EXPAND = 2;
  icalrecur_iterator.ILLEGAL = 3;
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};
(function () {
  ICAL.icaltime = function icaltime(data) {
    this.wrappedJSObject = this;
    this.fromData(data);
  };

  ICAL.icaltime.prototype = {

    year: 0,
    month: 1,
    day: 1,

    hour: 0,
    minute: 0,
    second: 0,

    isDate: false,
    zone: null,

    auto_normalize: false,
    icalclass: "icaltime",
    icaltype: "DATE-TIME",

    clone: function icaltime_clone() {
      return new ICAL.icaltime(this);
    },

    reset: function icaltime_reset() {
      this.fromData(ICAL.icaltime.epoch_time);
      this.zone = ICAL.icaltimezone.utc_timezone;
    },

    resetTo: function icaltime_resetTo(year, month, day, hour, minute, second, timezone) {
      this.fromData({
        year: year,
        month: month,
        day: day,
        hour: hour,
        minute: minute,
        second: second,
        zone: timezone
      });
    },

    fromString: function icaltime_fromString(str) {
      var data;
      try {
        data = ICAL.icalparser.parseValue(str, "DATE");
        data.isDate = true;
      } catch(e) {
        data = ICAL.icalparser.parseValue(str, "DATE-TIME");
        data.isDate = false;
      }
      return this.fromData(data);
    },

    fromJSDate: function icaltime_fromJSDate(aDate, useUTC) {
      if(!aDate) {
        this.reset();
      } else {
        if(useUTC) {
          this.zone = ICAL.icaltimzone.utc_timezone;
          this.year = aDate.getUTCFullYear();
          this.month = aDate.getUTCMonth() + 1;
          this.day = aDate.getUTCDate();
          this.hour = aDate.getUTCHours();
          this.minute = aDate.getUTCMinutes();
          this.second = aDate.getUTCSeconds();
        } else {
          this.zone = ICAL.icaltimezone.local_timezone;
          this.year = aDate.getFullYear();
          this.month = aDate.getMonth() + 1;
          this.day = aDate.getDate();
          this.hour = aDate.getHours();
          this.minute = aDate.getMinutes();
          this.second = aDate.getSeconds();
        }
      }
      return this;
    },

    fromData: function fromData(aData) {
      // TODO given we're switching formats, this may not be needed
      var old_auto_normalize = this.auto_normalize;
      this.auto_normalize = false;

      const propsToCopy = {
        year: 0,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0
      };
      for(var key in propsToCopy) {
        if(aData && key in aData) {
          this[key] = aData[key];
        } else {
          this[key] = propsToCopy[key];
        }
      }
      if(aData && !("isDate" in aData)) {
        this.isDate = !("hour" in aData);
      } else if(aData && ("isDate" in aData)) {
        this.isDate = aData.isDate;
      }

      if(aData && "timezone" in aData && aData.timezone == "Z") {
        this.zone = ICAL.icaltimezone.utc_timezone;
      }
      if(aData && "zone" in aData) {
        this.zone = aData.zone;
      }

      if(!this.zone) {
        this.zone = ICAL.icaltimezone.local_timezone;
      }

      this.auto_normalize = old_auto_normalize;
      if(this.auto_normalize) {
        this.normalize();
      }
      return this;
    },

    day_of_week: function icaltime_day_of_week() {
      // Using Zeller's algorithm
      var q = this.day;
      var m = this.month + (this.month < 3 ? 12 : 0);
      var Y = this.year - (this.month < 3 ? 1 : 0);

      var h = (q + Y + ICAL.helpers.trunc(((m + 1) * 26) / 10) + ICAL.helpers.trunc(Y / 4));
      if(true /* gregorian */ ) {
        h += ICAL.helpers.trunc(Y / 100) * 6 + ICAL.helpers.trunc(Y / 400);
      } else {
        h += 5;
      }

      // Normalize to 1 = sunday
      h = ((h + 6) % 7) + 1;
      return h;
    },

    day_of_year: function icaltime_day_of_year() {
      var is_leap = (ICAL.icaltime.is_leap_year(this.year) ? 1 : 0);
      return ICAL.icaltime._days_in_year_passed_month[is_leap][this.month - 1] + this.day;
    },

    start_of_week: function start_of_week() {
      var result = this.clone();
      result.day -= this.day_of_week() - 1;
      return result.normalize();
    },

    end_of_week: function end_of_week() {
      var result = this.clone();
      result.day += 7 - this.day_of_week();
      return result.normalize();
    },

    start_of_month: function start_of_month() {
      var result = this.clone();
      result.day = 1;
      result.isDate = true;
      result.hour = 0;
      result.minute = 0;
      result.second = 0;
      return result;
    },

    end_of_month: function end_of_month() {
      var result = this.clone();
      result.day = ICAL.icaltime.days_in_month(result.month, result.year);
      result.isDate = true;
      result.hour = 0;
      result.minute = 0;
      result.second = 0;
      return result;
    },

    start_of_year: function start_of_year() {
      var result = this.clone();
      result.day = 1;
      result.month = 1;
      result.isDate = true;
      result.hour = 0;
      result.minute = 0;
      result.second = 0;
      return result;
    },

    end_of_year: function end_of_year() {
      var result = this.clone();
      result.day = 31;
      result.month = 12;
      result.isDate = true;
      result.hour = 0;
      result.minute = 0;
      result.second = 0;
      return result;
    },

    start_doy_week: function start_doy_week(aFirstDayOfWeek) {
      var firstDow = aFirstDayOfWeek || ICAL.icaltime.SUNDAY;
      var delta = this.day_of_week() - firstDow;
      if(delta < 0) delta += 7;
      return this.day_of_year() - delta;
    },

    nth_weekday: function icaltime_nth_weekday(aDayOfWeek, aPos) {
      var days_in_month = ICAL.icaltime.days_in_month(this.month, this.year);
      var weekday;
      var pos = aPos;

      var otherday = this.clone();

      if(pos >= 0) {
        otherday.day = 1;
        var start_dow = otherday.day_of_week();

        if(pos != 0) {
          pos--;
        }

        weekday = aDayOfWeek - start_dow + 1;

        if(weekday <= 0) {
          weekday += 7;
        }
      } else {
        otherday.day = days_in_month;
        var end_dow = otherday.day_of_week();

        pos++;

        weekday = (end_dow - dow);

        if(weekday < 0) {
          weekday += 7;
        }

        weekday = days_in_month - weekday;
      }

      weekday += pos * 7;

      return weekday;
    },

    week_number: function week_number(aWeekStart) {
      // This function courtesty of Julian Bucknall, published under the MIT license
      // http://www.boyet.com/articles/publishedarticles/calculatingtheisoweeknumb.html
      var doy = this.day_of_year();
      var dow = this.day_of_week();
      var year = this.year;
      var week1;

      var dt = this.clone();
      dt.isDate = true;
      var first_dow = dt.day_of_week();
      var isoyear = this.year;

      if(dt.month == 12 && dt.day > 28) {
        week1 = ICAL.icaltime.week_one_starts(isoyear + 1, aWeekStart);
        if(dt.compare(week1) < 0) {
          week1 = ICAL.icaltime.week_one_starts(isoyear, aWeekStart);
        } else {
          isoyear++;
        }
      } else {
        week1 = ICAL.icaltime.week_one_starts(isoyear, aWeekStart);
        if(dt.compare(week1) < 0) {
          week1 = ICAL.icaltime.week_one_starts(--isoyear, aWeekStart);
        }
      }

      var daysBetween = (dt.subtractDate(week1).toSeconds() / 86400);
      return ICAL.helpers.trunc(daysBetween / 7) + 1;
    },

    addDuration: function icaltime_add(aDuration) {
      var mult = (aDuration.isNegative ? -1 : 1);

      this.second += mult * aDuration.seconds;
      this.minute += mult * aDuration.minutes;
      this.hour += mult * aDuration.hours;
      this.day += mult * aDuration.days;
      this.day += mult * 7 * aDuration.weeks;

      this.normalize();
    },

    subtractDate: function icaltime_subtract(aDate) {
      function leap_years_until(aYear) {
        return ICAL.helpers.trunc(aYear / 4) - ICAL.helpers.trunc(aYear / 100) + ICAL.helpers.trunc(aYear / 400);
      }

      function leap_years_between(aStart, aEnd) {
        if(aStart >= aEnd) {
          return 0;
        } else {
          return leap_years_until(aEnd - 1) - leap_years_until(aStart);
        }
      }
      var dur = new ICAL.icalduration();

      dur.seconds = this.second - aDate.second;
      dur.minutes = this.minute - aDate.minute;
      dur.hours = this.hour - aDate.hour;

      if(this.year == aDate.year) {
        var this_doy = this.day_of_year();
        var that_doy = aDate.day_of_year();
        dur.days = this_doy - that_doy;
      } else if(this.year < aDate.year) {
        var days_left_thisyear = 365 + (ICAL.icaltime.is_leap_year(this.year) ? 1 : 0) - this.day_of_year();

        dur.days -= days_left_thisyear + aDate.day_of_year();
        dur.days -= leap_years_between(this.year + 1, aDate.year);
        dur.days -= 365 * (aDate.year - this.year - 1);
      } else {
        var days_left_thatyear = 365 + (ICAL.icaltime.is_leap_year(aDate.year) ? 1 : 0) - aDate.day_of_year();

        dur.days += days_left_thatyear + this.day_of_year();
        dur.days += leap_years_between(aDate.year + 1, this.year);
        dur.days += 365 * (this.year - aDate.year - 1);
      }

      return dur.normalize();
    },

    compare: function icaltime_compare(other) {
      function cmp(attr) {
        return ICAL.icaltime._cmp_attr(a, b, attr);
      }

      if(!other) return 0;

      if(this.isDate || other.isDate) {
        return this.compare_date_only_tz(other, this.zone);
      }

      var target_zone;
      if(this.zone == ICAL.icaltimezone.local_timezone || other.zone == ICAL.icaltimezone.local_timezone) {
        target_zone = ICAL.icaltimezone.local_timezone;
      } else {
        target_zone = ICAL.icaltimezone.utc_timezone;
      }

      var a = this.convert_to_zone(target_zone);
      var b = other.convert_to_zone(target_zone);
      var rc = 0;

      if((rc = cmp("year")) != 0) return rc;
      if((rc = cmp("month")) != 0) return rc;
      if((rc = cmp("day")) != 0) return rc;

      if(a.isDate && b.isDate) {
        // If both are dates, we are done
        return 0;
      } else if(b.isDate) {
        // If b is a date, then a is greater
        return 1;
      } else if(a.isDate) {
        // If a is a date, then b is greater
        return -1;
      }

      if((rc = cmp("hour")) != 0) return rc;
      if((rc = cmp("minute")) != 0) return rc;
      if((rc = cmp("second")) != 0) return rc;

      // Now rc is 0 and the dates are equal
      return rc;
    },

    compare_date_only_tz: function icaltime_compare_date_only_tz(other, tz) {
      function cmp(attr) {
        return ICAL.icaltime._cmp_attr(a, b, attr);
      }
      var a = this.convert_to_zone(tz);
      var b = other.convert_to_zone(tz);
      var rc = 0;

      if((rc = cmp("year")) != 0) return rc;
      if((rc = cmp("month")) != 0) return rc;
      if((rc = cmp("day")) != 0) return rc;

      return rc;
    },

    convert_to_zone: function convert_to_zone(zone) {
      var copy = this.clone();
      var zone_equals = (this.zone.tzid == zone.tzid);

      if(!this.isDate && !zone_equals) {
        ICAL.icaltimezone.convert_time(copy, this.zone, zone)
      }

      copy.zone = zone;
      return copy;
    },

    utc_offset: function utc_offset() {
      if(this.zone == ICAL.icaltimezone.local_timezone || this.zone == ICAL.icaltimezone.utc_timezone) {
        return 0;
      } else {
        return this.zone.utc_offset(this);
      }
    },

    toString: function toString() {
      return("0000" + this.year).substr(-4) + ("00" + this.month).substr(-2) + ("00" + this.day).substr(-2) + (this.isDate ? "" : "T" + ("00" + this.hour).substr(-2) + ("00" + this.minute).substr(-2) + ("00" + this.second).substr(-2) + (this.zone && this.zone.tzid == "UTC" ? "Z" : ""));
    },

    toJSDate: function toJSDate() {
      if(this.zone == ICAL.icaltimezone.local_timezone) {
        if(this.isDate) {
          return new Date(this.year, this.month - 1, this.day);
        } else {
          return new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second, 0);
        }
      } else {
        var utcDate = this.convert_to_zone(ICAL.icaltimezone.utc_timezone);
        if(this.isDate) {
          return Date.UTC(this.year, this.month - 1, this.day);
        } else {
          return Date.UTC(this.year, this.month - 1, this.day, this.hour, this.minute, this.second, 0);
        }
      }
    },

    normalize: function icaltime_normalize() {
      if(this.isDate) {
        this.hour = 0;
        this.minute = 0;
        this.second = 0;
      }
      this.icaltype = (this.isDate ? "DATE" : "DATE-TIME");

      this.adjust(0, 0, 0, 0);
      return this;
    },

    adjust: function icaltime_adjust(aExtraDays, aExtraHours, aExtraMinutes, aExtraSeconds) {
      var second, minute, hour, day;
      var minutes_overflow, hours_overflow, days_overflow = 0,
        years_overflow = 0;
      var days_in_month;

      if(!this.isDate) {
        second = this.second + aExtraSeconds;
        this.second = second % 60;
        minutes_overflow = ICAL.helpers.trunc(second / 60);
        if(this.second < 0) {
          this.second += 60;
          minutes_overflow--;
        }

        minute = this.minute + aExtraMinutes + minutes_overflow;
        this.minute = minute % 60;
        hours_overflow = ICAL.helpers.trunc(minute / 60);
        if(this.minute < 0) {
          this.minute += 60;
          hours_overflow--;
        }

        hour = this.hour + aExtraHours + hours_overflow;
        this.hour = hour % 24;
        days_overflow = ICAL.helpers.trunc(hour / 24);
        if(this.hour < 0) {
          this.hour += 24;
          days_overflow--;
        }
      }

      // Adjust month and year first, because we need to know what month the day is in
      // before adjusting it.
      if(this.month > 12) {
        years_overflow = ICAL.helpers.trunc((this.month - 1) / 12);
      } else if(this.month < 1) {
        years_overflow = ICAL.helpers.trunc(this.month / 12) - 1;
      }

      this.year += years_overflow;
      this.month -= 12 * years_overflow;

      // Now take care of the days (and adjust month if needed)
      day = this.day + aExtraDays + days_overflow;
      if(day > 0) {
        for(;;) {
          var days_in_month = ICAL.icaltime.days_in_month(this.month, this.year);
          if(day <= days_in_month) {
            break;
          }

          this.month++;
          if(this.month > 12) {
            this.year++;
            this.month = 1;
          }

          day -= days_in_month;
        }
      } else {
        while(day <= 0) {
          if(this.month == 1) {
            this.year--;
            this.month = 12;
          } else {
            this.month--;
          }

          day += ICAL.icaltime.days_in_month(this.month, this.year);
        }
      }

      this.day = day;
      return this;
    },

    fromUnixTime: function fromUnixTime(seconds) {
      var epoch = ICAL.icaltime.epoch_time.clone();
      epoch.adjust(0, 0, 0, seconds);
      this.fromData(epoch);
      this.zone = ICAL.icaltimezone.utc_timezone;
    },

    toUnixTime: function toUnixTime() {
      var dur = this.subtractDate(ICAL.icaltime.epoch_time);
      return dur.toSeconds();
    }
  };

  (function setupNormalizeAttributes() {
    // This needs to run before any instances are created!
    function addAutoNormalizeAttribute(attr, mattr) {
      ICAL.icaltime.prototype[mattr] = ICAL.icaltime.prototype[attr];

      Object.defineProperty(ICAL.icaltime.prototype, attr, {
        get: function () {
          return this[mattr];
        },
        set: function (val) {
          this[mattr] = val;
          if(this.auto_normalize) {
            var old_normalize = this.auto_normalize;
            this.auto_normalize = false;
            this.normalize();
            this.auto_normalize = old_normalize;
          }
          return val;
        }
      });

    }

    if("defineProperty" in Object) {
      addAutoNormalizeAttribute("year", "mYear");
      addAutoNormalizeAttribute("month", "mMonth");
      addAutoNormalizeAttribute("day", "mDay");
      addAutoNormalizeAttribute("hour", "mHour");
      addAutoNormalizeAttribute("minute", "mMinute");
      addAutoNormalizeAttribute("second", "mSecond");
      addAutoNormalizeAttribute("isDate", "mIsDate");

      ICAL.icaltime.prototype.auto_normalize = true;
    }
  })();

  ICAL.icaltime.days_in_month = function icaltime_days_in_month(month, year) {
    const _days_in_month = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    var days = 30;

    if(month < 1 || month > 12) return days;

    days = _days_in_month[month];

    if(month == 2) {
      days += ICAL.icaltime.is_leap_year(year);
    }

    return days;
  };

  ICAL.icaltime.is_leap_year = function icaltime_is_leap_year(year) {
    if(year <= 1752) {
      return((year % 4) == 0);
    } else {
      return(((year % 4 == 0) && (year % 100 != 0)) || (year % 400 == 0));
    }
  };

  ICAL.icaltime.from_day_of_year = function icaltime_from_day_of_year(aDayOfYear, aYear) {
    var year = aYear;
    var doy = aDayOfYear;
    var tt = new ICAL.icaltime();
    tt.auto_normalize = false;
    var is_leap = (ICAL.icaltime.is_leap_year(year) ? 1 : 0);

    if(doy < 1) {
      year--;
      is_leap = (ICAL.icaltime.is_leap_year(year) ? 1 : 0);
      doy += ICAL.icaltime._days_in_year_passed_month[is_leap][12];
    } else if(doy > ICAL.icaltime._days_in_year_passed_month[is_leap][12]) {
      is_leap = (ICAL.icaltime.is_leap_year(year) ? 1 : 0);
      doy -= ICAL.icaltime._days_in_year_passed_month[is_leap][12];
      year++;
    }

    tt.year = year;
    tt.isDate = true;

    for(var month = 11; month >= 0; month--) {
      if(doy > ICAL.icaltime._days_in_year_passed_month[is_leap][month]) {
        tt.month = month + 1;
        tt.day = doy - ICAL.icaltime._days_in_year_passed_month[is_leap][month];
        break;
      }
    }

    tt.auto_normalize = true;
    return tt;
  };

  ICAL.icaltime.fromString = function fromString(str) {
    var tt = new ICAL.icaltime();
    return tt.fromString(str);
  };

  ICAL.icaltime.fromJSDate = function fromJSDate(aDate, useUTC) {
    var tt = new ICAL.icaltime();
    return tt.fromJSDate(aDate, useUTC);
  };

  ICAL.icaltime.fromData = function fromData(aData) {
    var t = new ICAL.icaltime();
    return t.fromData(aData);
  };

  ICAL.icaltime.now = function icaltime_now() {
    return ICAL.icaltime.fromJSDate(new Date(), false);
  };

  ICAL.icaltime.week_one_starts = function week_one_starts(aYear, aWeekStart) {
    var t = ICAL.icaltime.fromData({
      year: aYear,
      month: 1,
      day: 4,
      isDate: true
    });

    var fourth_dow = t.day_of_week();
    t.day += (1 - fourth_dow) + ((aWeekStart || ICAL.icaltime.SUNDAY) - 1);
    return t;
  };

  ICAL.icaltime.epoch_time = ICAL.icaltime.fromData({
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    isDate: false,
    timezone: "Z"
  });

  ICAL.icaltime._cmp_attr = function _cmp_attr(a, b, attr) {
    if(a[attr] > b[attr]) return 1;
    if(a[attr] < b[attr]) return -1;
    return 0;
  };

  ICAL.icaltime._days_in_year_passed_month = [
    [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365],
    [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366]
  ];

  ICAL.icaltime.SUNDAY = 1;
  ICAL.icaltime.MONDAY = 2;
  ICAL.icaltime.TUESDAY = 3;
  ICAL.icaltime.WEDNESDAY = 4;
  ICAL.icaltime.THURSDAY = 5;
  ICAL.icaltime.FRIDAY = 6;
  ICAL.icaltime.SATURDAY = 7;
})();
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var ICAL = ICAL || {};

(function () {
  ICAL.foldLength = 75;
  ICAL.newLineChar = "\n";

  /**
   * Return a parsed ICAL object to the ICAL format.
   *
   * @param {Object} object parsed ical string.
   * @return {String} ICAL string.
   */
  ICAL.stringify = function ICALStringify(object) {
    return ICAL.serializer.serializeToIcal(object);
  };

  /**
   * Parse an ICAL object or string.
   *
   * @param {String|Object} ical ical string or pre-parsed object.
   * @param {Boolean} decorate when true decorates object data types.
   *
   * @return {Object|ICAL.icalcomponent}
   */
  ICAL.parse = function ICALParse(ical) {
    var state = ICAL.helpers.initState(ical, 0);

    while(state.buffer.length) {
      var line = ICAL.helpers.unfoldline(state);
      var lexState = ICAL.helpers.initState(line, state.lineNr);
      var lineData = ICAL.icalparser.lexContentLine(lexState);
      ICAL.icalparser.parseContentLine(state, lineData);
      state.lineNr++;
    }

    return state.currentData;
  };
}());