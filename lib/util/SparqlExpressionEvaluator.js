/*! @license MIT ©2014-2016 Ruben Verborgh, Ghent University - imec */
/*! GeoSPARQL support added by Christophe Debruyne, Trinity College Dublin */

var N3Util = require('n3').Util,
    createErrorType = require('./CustomError');

var XSD = 'http://www.w3.org/2001/XMLSchema#',
    XSD_INTEGER = XSD + 'integer',
    XSD_DOUBLE  = XSD + 'double',
    XSD_BOOLEAN = XSD + 'boolean',
    XSD_TRUE  = '"true"^^'  + XSD_BOOLEAN,
    XSD_FALSE = '"false"^^' + XSD_BOOLEAN;

var evaluators, operators,
    UnsupportedExpressionError, UnsupportedOperatorError, InvalidArgumentsNumberError;

var isLiteral = N3Util.isLiteral,
    literalValue = N3Util.getLiteralValue;

/* Begin support for GeoSPARQL */

// Libraries for parsing geo-coords and spatial helper functions
var WKT = require('terraformer-wkt-parser');
var turf = require('@turf/turf');

function isOrContainsPolygon(a) {
  if (a.geometry.type.indexOf('Polygon') >= 0)
    return true;
  if (a.geometry.type.indexOf('GeometryCollection') >= 0) {
    for (var object in a.geometry.geometries) {
      if (object.type.indexOf('Polygon') >= 0)
        return true;
    }
  }
  return false;
}

function contains(a, b) {
  return within(b, a);
}

function disjoint(a, b) {
  // intersection is empty
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  return turf.intersect(gA, gB) === undefined ? XSD_TRUE : XSD_FALSE;
}

function equals(a, b) {
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  var intersection = turf.intersect(gA, gB);
  if (intersection !== undefined) {
    if (turf.difference(gA, intersection) === undefined) {
      if (turf.difference(gB, intersection) === undefined)
        return XSD_TRUE;
    }
  }
  return XSD_FALSE;
}

function intersects(a, b) {
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  return turf.intersect(gA, gB) !== undefined ? XSD_TRUE : XSD_FALSE;
}

function overlaps(a, b) {
  // This implementation of overlaps currently only supports (Multi)Polygons
  // TODO: investigate support for combination of Points, Lines, and Polygons...
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  var intersection = turf.intersect(gA, gB);
  // if intersection exists and not line(s) or point(s)
  if (intersection !== undefined && isOrContainsPolygon(intersection)) {
    if (turf.difference(gA, intersection) !== undefined)
      return XSD_TRUE;
    if (turf.difference(gB, intersection) !== undefined)
      return XSD_TRUE;
  }
  return XSD_FALSE;
}

function touches(a, b) {
  // This implementation assumes that things that touch do not contain polygons in the
  // intersection. This assumption might be naive and needs further investigating
  // TODO: check approach
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  var intersection = turf.intersect(gA, gB);
  if (intersection !== undefined) {
    if (!isOrContainsPolygon(intersection))
      return XSD_TRUE;
  }
  return XSD_FALSE;
}

function within(a, b) {
  // NOTE RCC8 CONSIDERS TPP AND nTTP AS DIFFERENT, BUT SAME PREDICATE IN GEOSPARQL
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  var intersection = turf.intersect(gA, gB);
  if (intersection !== undefined) {
    // TEST IF A AND B !== EMPTY
    var diff = turf.difference(gA, intersection);
    if (diff === undefined) {
      // TEST IF A - (A AND B) = EMPTY
      diff = turf.difference(gB, intersection);
      if (diff !== undefined) {
        // TEST IF B - (A AND B) !== EMPTY
        return XSD_TRUE;
      }
    }
  }
  return XSD_FALSE;
}

/* End support for GeoSPARQL */

/**
 * Creates a function that evaluates the given SPARQL expression.
 * @constructor
 * @param expression a SPARQL expression
 * @returns {Function} a function that evaluates the SPARQL expression.
 */
function SparqlExpressionEvaluator(expression) {
  if (!expression) return noop;
  var expressionType = expression && expression.type || typeof expression,
      evaluator = evaluators[expressionType];
  if (!evaluator) throw new UnsupportedExpressionError(expressionType);
  return evaluator(expression);
}

// Evaluates the expression with the given bindings
SparqlExpressionEvaluator.evaluate = function (expression, bindings) {
  return new SparqlExpressionEvaluator(expression)(bindings);
};

// The null operation
function noop() { }

// Evaluators for each of the expression types
evaluators = {
  // Does nothing
  null: function () { return noop; },

  // Evaluates an IRI, literal, or variable
  string: function (expression) {
    // Evaluate a IRIs or literal to its own value
    if (expression[0] !== '?')
      return function () { return expression; };
    // Evaluate a variable to its value
    else
      return function (bindings) { return bindings && bindings[expression]; };
  },

  // Evaluates an operation
  operation: function (expression) {
    // Find the operator and check the number of arguments matches the expression
    var operatorName = expression.operator || expression.function,
        operator = operators[operatorName];
    if (!operator)
      throw new UnsupportedOperatorError(operatorName);
    if (operator.length !== expression.args.length)
      throw new InvalidArgumentsNumberError(operatorName, expression.args.length, operator.length);

    // Special case: some operators accept expressions instead of evaluated expressions
    if (operator.acceptsExpressions) {
      return (function (operator, args) {
        return function (bindings) {
          return operator.apply(bindings, args);
        };
      })(operator, expression.args);
    }

    // Parse the expressions for each of the arguments
    var argumentExpressions = new Array(expression.args.length);
    for (var i = 0; i < expression.args.length; i++)
      argumentExpressions[i] = new SparqlExpressionEvaluator(expression.args[i]);

    // Create a function that evaluates the operator with the arguments and bindings
    return (function (operator, argumentExpressions) {
      return function (bindings) {
        // Evaluate the arguments
        var args = new Array(argumentExpressions.length),
            origArgs = new Array(argumentExpressions.length);
        for (var i = 0; i < argumentExpressions.length; i++) {
          var arg = args[i] = origArgs[i] = argumentExpressions[i](bindings);
          // If any argument is undefined, the result is undefined
          if (arg === undefined) return;
          // Convert the arguments if necessary
          switch (operator.type) {
          case 'numeric':
            args[i] = parseFloat(literalValue(arg));
            break;
          case 'boolean':
            args[i] = arg !== XSD_FALSE &&
                     (!isLiteral(arg) || literalValue(arg) !== '0');
            break;
          }
        }
        // Call the operator on the evaluated arguments
        var result = operator.apply(null, args);
        // Convert result if necessary
        switch (operator.resultType) {
        case 'numeric':
          // TODO: determine type instead of taking the type of the first argument
          var type = N3Util.getLiteralType(origArgs[0]) || XSD_INTEGER;
          return '"' + result + '"^^' + type;
        case 'boolean':
          return result ? XSD_TRUE : XSD_FALSE;
        default:
          return result;
        }
      };
    })(operator, argumentExpressions);
  },
};
evaluators.functionCall = evaluators.operation;

// Operators for each of the operator types
operators = {
  '+':  function (a, b) { return a  +  b; },
  '-':  function (a, b) { return a  -  b; },
  '*':  function (a, b) { return a  *  b; },
  '/':  function (a, b) { return a  /  b; },
  '=':  function (a, b) { return a === b; },
  '!=': function (a, b) { return a !== b; },
  '<':  function (a, b) { return a  <  b; },
  '<=': function (a, b) { return a  <= b; },
  '>':  function (a, b) { return a  >  b; },
  '>=': function (a, b) { return a  >= b; },
  '!':  function (a)    { return !a;      },
  '&&': function (a, b) { return a &&  b; },
  '||': function (a, b) { return a ||  b; },
  'lang': function (a)    {
    return '"' + N3Util.getLiteralLanguage(a).toLowerCase() + '"';
  },
  'langmatches': function (langTag, langRange) {
    // Implements https://tools.ietf.org/html/rfc4647#section-3.3.1
    langTag = langTag.toLowerCase();
    langRange = langRange.toLowerCase();
    return langTag === langRange ||
           (langRange = literalValue(langRange)) === '*' ||
           langTag.substr(1, langRange.length + 1) === langRange + '-';
  },
  'contains': function (string, substring) {
    substring = literalValue(substring);
    string = literalValue(string);
    return string.indexOf(substring) >= 0;
  },
  'regex': function (subject, pattern) {
    if (isLiteral(subject))
      subject = literalValue(subject);
    return new RegExp(literalValue(pattern)).test(subject);
  },
  'str': function (a) {
    return isLiteral(a) ? a : '"' + a + '"';
  },
  'http://www.w3.org/2001/XMLSchema#integer': function (a) {
    return '"' + Math.floor(a) + '"^^http://www.w3.org/2001/XMLSchema#integer';
  },
  'http://www.w3.org/2001/XMLSchema#double': function (a) {
    a = a.toFixed();
    if (a.indexOf('.') < 0) a += '.0';
    return '"' + a + '"^^http://www.w3.org/2001/XMLSchema#double';
  },
  'bound': function (a) {
    if (a[0] !== '?')
      throw new Error('BOUND expects a variable but got: ' + a);
    return a in this ? XSD_TRUE : XSD_FALSE;
  },
  'http://www.opengis.net/def/function/geosparql/sfContains': contains,
  'http://www.opengis.net/def/function/geosparql/sfDisjoint': disjoint,
  'http://www.opengis.net/def/function/geosparql/sfEquals': equals,
  'http://www.opengis.net/def/function/geosparql/sfIntersects': intersects,
  'http://www.opengis.net/def/function/geosparql/sfOverlaps': overlaps,
  'http://www.opengis.net/def/function/geosparql/sfTouches': touches,
  'http://www.opengis.net/def/function/geosparql/sfWithin': within,
};

// Tag all operators that expect their arguments to be numeric
// TODO: Comparison operators can take simple literals and strings as well
[
  '+', '-', '*', '/', '<', '<=', '>', '>=',
  XSD_INTEGER, XSD_DOUBLE,
].forEach(function (operatorName) {
  operators[operatorName].type = 'numeric';
});

// Tag all operators that expect their arguments to be boolean
[
  '!', '&&', '||',
].forEach(function (operatorName) {
  operators[operatorName].type = 'boolean';
});

// Tag all operators that have numeric results
[
  '+', '-', '*', '/',
].forEach(function (operatorName) {
  operators[operatorName].resultType = 'numeric';
});

// Tag all operators that have boolean results
[
  '!', '&&', '||', '=', '!=', '<', '<=', '>', '>=',
  'langmatches', 'contains', 'regex',
].forEach(function (operatorName) {
  operators[operatorName].resultType = 'boolean';
});

// Tag all operators that take expressions instead of evaluated expressions
operators.bound.acceptsExpressions = true;



UnsupportedExpressionError = createErrorType('UnsupportedExpressionError', function (expressionType) {
  this.message = 'Unsupported expression type: ' + expressionType + '.';
});

UnsupportedOperatorError = createErrorType('UnsupportedExpressionError', function (operatorName) {
  this.message = 'Unsupported operator: ' + operatorName + '.';
});

InvalidArgumentsNumberError = createErrorType('InvalidArgumentsNumberError',
function (operatorName, actualNumber, expectedNumber) {
  this.message = 'Invalid number of arguments for ' + operatorName + ': ' +
                 actualNumber + ' (expected: ' + expectedNumber + ').';
});



module.exports = SparqlExpressionEvaluator;
module.exports.UnsupportedExpressionError = UnsupportedExpressionError;
module.exports.UnsupportedOperatorError = UnsupportedOperatorError;
module.exports.InvalidArgumentsNumberError = InvalidArgumentsNumberError;
