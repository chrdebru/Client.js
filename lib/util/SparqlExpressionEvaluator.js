/*! @license MIT ©2014-2016 Ruben Verborgh, Ghent University - imec */
/*! GeoSPARQL support added by Christophe Debruyne, Trinity College Dublin */
var N3Util = require('n3').Util,
    createErrorType = require('./CustomError');
var XSD = 'http://www.w3.org/2001/XMLSchema#',
    GEO = 'http://www.opengis.net/ont/geosparql#',
    XSD_INTEGER = XSD + 'integer',
    XSD_DOUBLE = XSD + 'double',
    XSD_BOOLEAN = XSD + 'boolean',
    XSD_TRUE = '"true"^^' + XSD_BOOLEAN,
    XSD_FALSE = '"false"^^' + XSD_BOOLEAN,
    WKT_LITERAL = GEO + 'wktLiteral';
var evaluators, operators,
    UnsupportedExpressionError, UnsupportedOperatorError, UnsupportedUnitError, InvalidArgumentsNumberError, UnsupportedCoordinateSystemError;
var isLiteral = N3Util.isLiteral,
    literalValue = N3Util.getLiteralValue;


/* Begin support for GeoSPARQL */

// Libraries for parsing geo-coords and spatial helper functions
var WKT = require('terraformer-wkt-parser');
var turf = require('@turf/turf');

function filterCoordinateSystem(geom) {
  var regex = /<[^>]*>/;
  if (!regex.test(regex)) { // test if coordinate uri exist
    return geom;
  }
  else {
    var coordinateSystem = regex.exec(geom)[0];
    if (coordinateSystem === '<http://www.opengis.net/def/crs/EPSG/4326>')
      return '\"' + geom.split('>')[1].trim();// drop the coordinate system
    else
      throw new UnsupportedCoordinateSystemError(coordinateSystem);
  }
}

function contains(a, b) {
  return within(b, a);
}
function disjoint(a, b) {
  // intersection is empty
  a = filterCoordinateSystem(a);
  b = filterCoordinateSystem(b);
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  return turf.intersect(gA, gB) === undefined ? XSD_TRUE : XSD_FALSE;
}
function equals(a, b) {
  a = filterCoordinateSystem(a);
  b = filterCoordinateSystem(b);
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
  a = filterCoordinateSystem(a);
  b = filterCoordinateSystem(b);
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  return turf.intersect(gA, gB) !== undefined ? XSD_TRUE : XSD_FALSE;
}
function overlaps(a, b) {
  a = filterCoordinateSystem(a);
  b = filterCoordinateSystem(b);
  // This implementation of overlaps currently only supports (Multi)Polygons
  // TODO: investigate support for combination of Points, Lines, and Polygons...
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  var intersection = turf.intersect(gA, gB);
  // if intersection exists and not line(s) or point(s)
  if (intersection !== undefined && intersection.geometry.type.indexOf('Polygon') >= 0) {
    if (turf.difference(gA, intersection) !== undefined)
      return XSD_TRUE;
    if (turf.difference(gB, intersection) !== undefined)
      return XSD_TRUE;
  }
  return XSD_FALSE;
}
function touches(a, b) {
  a = filterCoordinateSystem(a);
  b = filterCoordinateSystem(b);
  // This implementation assumes that things that touch do not contain polygons in the
  // intersection. This assumption might be naive and needs further investigating
  // TODO: check approach
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));
  var intersection = turf.intersect(gA, gB);
  if (intersection !== undefined) {
    if (intersection.geometry.type.indexOf('Polygon') < 0)
      return XSD_TRUE;
  }
  return XSD_FALSE;
}
function crosses(a, b) {
  a = filterCoordinateSystem(a);
  b = filterCoordinateSystem(b);
  var gA = WKT.parse(N3Util.getLiteralValue(a));
  var gB = WKT.parse(N3Util.getLiteralValue(b));

  /*
   Accepted geometry type: P/L, P/A, L/A, L/L
   DE-9IM:
   (T*T***T**) for P/L, P/A, L/A;
   (0*T***T**) for L/L
   */
  if (gA.type === 'Point' && gB.type === 'Point') {
    // terminate the function for P/P situation
    // TODO handle an exception
    // console.log("sfCrosses can't take two points as arguments");
    return XSD_FALSE;
  }
  if (gA.type === 'Polygon' && gB.type === 'Polygon') {
    // terminate the function for A/A situation
    // TODO handle an exception
    // console.log("sfCrosses can't take two polygon as arguments");
    return XSD_FALSE;
  }
  var crossPoint;
  var featuredLine1, featuredLine2;
  if (gA.type === 'LineString' && gB.type === 'LineString') {
    // test cross for L/L
    featuredLine1 = turf.feature(gA);
    featuredLine2 = turf.feature(gB);
    crossPoint = turf.lineIntersect(featuredLine1, featuredLine2);
    if (crossPoint !== undefined) {
      // return true if cross point(s) of two LineStrings exists
      return XSD_TRUE;
    }
    return XSD_FALSE;
  }
  var featuredPoint, featuredLine, featuredGeom;
  var nearestPoint;
  if (gA.type === 'Point') {
    featuredPoint = turf.feature(gA);
    switch (gB.type) {
    case 'LineString':
      featuredLine = turf.feature(gB);
      // pointOnLine method can help find the nearest point from the given point on the line
      nearestPoint = turf.pointOnLine(featuredPoint, featuredLine);
      if (nearestPoint !== undefined)
        return (nearestPoint.properties.dist > 0) ? XSD_FALSE : XSD_TRUE;
      break;
    case 'Polygon':
      featuredGeom = turf.feature(gB);
      return turf.inside(featuredPoint, featuredGeom) ? XSD_TRUE : XSD_FALSE;
    }
  }
  if (gA.type === 'LineString') {
    featuredLine = turf.feature(gA);
    switch (gB.type) {
    case 'Point':
      featuredPoint = turf.feature(gB);
      nearestPoint = turf.pointOnLine(featuredPoint, featuredLine);
      if (nearestPoint !== undefined)
        return (nearestPoint.properties.dist > 0) ? XSD_FALSE : XSD_TRUE;
      break;
    case 'Polygon':
      featuredGeom = turf.feature(gB);
      crossPoint = turf.lineIntersect(featuredLine, featuredGeom);
      if (crossPoint !== undefined)
        return XSD_TRUE;
      else
        return XSD_FALSE;
    }
  }
  if (gA.type === 'Polygon') {
    featuredGeom = turf.feature(gA);
    switch (gB.type) {
    case 'LineString':
      featuredLine = turf.feature(gB);
      crossPoint = turf.lineIntersect(featuredLine, featuredGeom);
      if (crossPoint !== undefined)
        return XSD_TRUE;
      else
        return XSD_FALSE;
    case 'Point':
      featuredPoint = turf.feature(gB);
      return turf.inside(featuredPoint, featuredGeom) ? XSD_TRUE : XSD_FALSE;
    }
  }
  return XSD_FALSE;
}
function within(a, b) {
  a = filterCoordinateSystem(a);
  b = filterCoordinateSystem(b);
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

/**
 *
 * @param geom1
 * @param geom2
 * @returns a geometric object that represents all Points in the union of geom1 with geom2.
 * Calculations are in the spatial reference system of geom1.
 */
function union(geom1, geom2) {
  geom1 = filterCoordinateSystem(geom1);
  geom2 = filterCoordinateSystem(geom2);
  // TODO accept a set of polygons as arguments
  var gA = WKT.parse(N3Util.getLiteralValue(geom1));
  var gB = WKT.parse(N3Util.getLiteralValue(geom2));
  // this method only take two polygons as inputs
  if (gA.type === 'Polygon' && gB.type === 'Polygon') {
    // extend the geometry to support turf
    var poly1 = turf.feature(gA);
    var poly2 = turf.feature(gB);
    // calling turf method
    var union = turf.union(poly1, poly2);
    if (union !== undefined) {
      // TODO test the correctness of turf.union
      return WKT.convert(union.geometry);
    }
  }
}

/**
 *
 * @param geom1
 * @param geom2
 * @param units
 * @returns the shortest distance in units between any two Points in the two geometric
 * objects as calculated in the spatial reference system of geom1.
 */
function distance(geom1, geom2, units) {
  // TODO test if two argumens are points
  geom1 = filterCoordinateSystem(geom1);
  geom2 = filterCoordinateSystem(geom2);
  var gA = WKT.parse(N3Util.getLiteralValue(geom1));
  var gB = WKT.parse(N3Util.getLiteralValue(geom2));
  var parsedUnit = 'meters';// set meter as default value
  if (N3Util.isIRI(units)) {
    units = units.split('/');
    units = units[units.length - 1];
    switch (units) {
    case 'metre' : parsedUnit = 'meters';
      break;
    case 'degree': parsedUnit = 'degrees';
      break;
    case 'radian': parsedUnit = 'radians';
      break;
    case 'GridSpacing' : throw new UnsupportedUnitError(units);
    case 'unity' : throw new UnsupportedUnitError(units);
    }
  }
  if (N3Util.isLiteral(units)) {
    // TODO check if the literal value is not a valid unit
    parsedUnit = N3Util.getLiteralValue(units);
  }
  var point1 = turf.feature(gA);
  var point2 = turf.feature(gB);
  var distance = turf.distance(point1, point2, parsedUnit);
  if (distance !== undefined) {
    // TODO test the correctness of turf.distance
    return distance;
  }
}

/**
 *
 * @param geom1
 * @param radius
 * @param units
 * @returns a geometric object that represents all Points whose distance from geom1 is less than or equal to the radius measured in units.
 * Calculations are in the spatial reference system of geom1.
 */
function buffer(geom1, radius, units) {
  geom1 = filterCoordinateSystem(geom1);
  var geom = WKT.parse(N3Util.getLiteralValue(geom1));
  var featuredGeom = turf.feature(geom);
  var parsedUnit = 'meters';// set meter as default value
  if (N3Util.isIRI(units)) {
    units = units.split('/');
    units = units[units.length - 1];
    switch (units) {
    case 'metre' : parsedUnit = 'meters';
      break;
    case 'degree': parsedUnit = 'degrees';
      break;
    case 'radian': parsedUnit = 'radians';
      break;
    case 'GridSpacing' : throw new UnsupportedUnitError(units);
    case 'unity' : throw new UnsupportedUnitError(units);
    }
  }
  if (N3Util.isLiteral(units)) {
    // TODO check if the literal value is not a valid unit
    parsedUnit = N3Util.getLiteralValue(units);
  }
  var buffer = turf.buffer(featuredGeom, N3Util.getLiteralValue(radius), parsedUnit);
  if (buffer !== undefined)
    return WKT.convert(buffer.geometry);
}

/**
 *
 * @param geom1
 * @returns a geometric object that represents all Points in the convex hull of geom1.
 * Calculations are in the spatial reference system of geom1.
 */
function convexHull(geom1) {
  geom1 = filterCoordinateSystem(geom1);
  var geom = WKT.parse(N3Util.getLiteralValue(geom1));
  var featuredGeom = turf.feature(geom);
  var convexHull = turf.convex(featuredGeom);
  if (convexHull !== undefined)
    return WKT.convert(convexHull.geometry);
}

/**
 *
 * @param geom1
 * @param geom2
 * @returns This function returns a geometric object that represents all Points in the intersection of geom1 with geom2.
 * Calculations are in the spatial reference system of geom1.
 */
function intersection(geom1, geom2) {
  geom1 = filterCoordinateSystem(geom1);
  geom2 = filterCoordinateSystem(geom2);
  var gA = WKT.parse(N3Util.getLiteralValue(geom1));
  var gB = WKT.parse(N3Util.getLiteralValue(geom2));
  if (gA.type === 'Polygon' && gB.type === 'Polygon') {
    var featuredGeom1 = turf.feature(gA);
    var featuredGeom2 = turf.feature(gB);
    var intersection = turf.intersect(featuredGeom1, featuredGeom2);
    if (intersection !== undefined)
      return intersection;
  }
}

/**
 *
 * @param geom1
 * @returns This function returns the minimum bounding box of geom1. Calculations are in the
 spatial reference system of geom1.
 */
function envelope(geom1) {
  geom1 = filterCoordinateSystem(geom1);
  var geom = WKT.parse(N3Util.getLiteralValue(geom1));
  var featuredGeom = turf.feature(geom);
  var envelope = turf.envelope(featuredGeom);
  if (envelope !== undefined)
    return WKT.convert(envelope.geometry);
}

/**
 *
 * @param geom1
 * @param geom2
 * @returns This function returns a geometric object that represents all Points in the set difference of geom1 with geom2.
 * Calculations are in the spatial reference system of geom1.
 */
function difference(geom1, geom2) {
  geom1 = filterCoordinateSystem(geom1);
  geom2 = filterCoordinateSystem(geom2);
  var gA = WKT.parse(N3Util.getLiteralValue(geom1));
  var gB = WKT.parse(N3Util.getLiteralValue(geom2));
  if (gA.type === 'Polygon' && gB.type === 'Polygon') {
    var featuredGeom1 = turf.feature(gA);
    var featuredGeom2 = turf.feature(gB);
    var diff = turf.difference(featuredGeom1, featuredGeom2);
    if (diff !== undefined)
      return diff;
  }
}

/**
 *
 * @param geom1
 * @param geom2
 * @returns a geometric object that represents all Points in the set symmetric difference of geom1 with geom2.
 * Calculations are in the spatial reference system of geom1.
 */
function symDifference(geom1, geom2) {
  geom1 = filterCoordinateSystem(geom1);
  geom2 = filterCoordinateSystem(geom2);
  var gA = WKT.parse(N3Util.getLiteralValue(geom1));
  var gB = WKT.parse(N3Util.getLiteralValue(geom2));
  if (gA.type === 'Polygon' && gB.type === 'Polygon') {
    var featuredGeom1 = turf.feature(gA);
    var featuredGeom2 = turf.feature(gB);
    var intersection = turf.intersect(featuredGeom1, featuredGeom2);
    if (intersection !== undefined) {
      var symDiff = turf.union(turf.difference(featuredGeom1, intersection), turf.difference(featuredGeom2, intersection));
      if (symDiff !== undefined)
        return symDiff;
    }
  }
}

/**
 *
 * @param geom1
 * @returns This function returns the closure of the boundary of geom1. Calculations are in the spatial
 reference system of geom1.
 */
function boundary(geom1) {

  // not very clear with its specification
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
function noop() {
}
// Evaluators for each of the expression types
evaluators = {
  // Does nothing
  null: function () {
    return noop;
  },
  // Evaluates an IRI, literal, or variable
  string: function (expression) {
    // Evaluate a IRIs or literal to its own value
    if (expression[0] !== '?') {
      return function () {
        return expression;
      };
      // Evaluate a variable to its value
    }
    else {
      return function (bindings) {
        return bindings && bindings[expression];
      };
    }
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
        case 'wkt' :
          return '"' + result + '"^^' + WKT_LITERAL;
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
  '+': function (a, b) {
    return a + b;
  },
  '-': function (a, b) {
    return a - b;
  },
  '*': function (a, b) {
    return a * b;
  },
  '/': function (a, b) {
    return a / b;
  },
  '=': function (a, b) {
    return a === b;
  },
  '!=': function (a, b) {
    return a !== b;
  },
  '<': function (a, b) {
    return a < b;
  },
  '<=': function (a, b) {
    return a <= b;
  },
  '>': function (a, b) {
    return a > b;
  },
  '>=': function (a, b) {
    return a >= b;
  },
  '!': function (a) {
    return !a;
  },
  '&&': function (a, b) {
    return a && b;
  },
  '||': function (a, b) {
    return a || b;
  },
  'lang': function (a) {
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
  // geo-sparql filter functions
  'http://www.opengis.net/def/function/geosparql/sfContains': contains,
  'http://www.opengis.net/def/function/geosparql/sfDisjoint': disjoint,
  'http://www.opengis.net/def/function/geosparql/sfEquals': equals,
  'http://www.opengis.net/def/function/geosparql/sfIntersects': intersects,
  'http://www.opengis.net/def/function/geosparql/sfOverlaps': overlaps,
  'http://www.opengis.net/def/function/geosparql/sfTouches': touches,
  'http://www.opengis.net/def/function/geosparql/sfCrosses': crosses,
  'http://www.opengis.net/def/function/geosparql/sfWithin': within,
  // geo-sparql non-topological functions
  'http://www.opengis.net/def/function/geosparql/distance': distance,
  'http://www.opengis.net/def/function/geosparql/union': union,
  'http://www.opengis.net/def/function/geosparql/buffer': buffer,
  'http://www.opengis.net/def/function/geosparql/convexHull': convexHull,
  'http://www.opengis.net/def/function/geosparql/intersection': intersection,
  'http://www.opengis.net/def/function/geosparql/difference': difference,
  'http://www.opengis.net/def/function/geosparql/symDifference': symDifference,
  'http://www.opengis.net/def/function/geosparql/envelope': envelope,
  'http://www.opengis.net/def/function/geosparql/boundary': boundary,
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
['http://www.opengis.net/def/function/geosparql/union',
].forEach(function (operatorName) {
  operators[operatorName].resultType = 'wkt';
});
['http://www.opengis.net/def/function/geosparql/distance'].forEach(function (operatorName) {
  operators[operatorName].resultType = 'numeric';
});
// Tag all operators that take expressions instead of evaluated expressions
operators.bound.acceptsExpressions = true;
UnsupportedExpressionError = createErrorType('UnsupportedExpressionError', function (expressionType) {
  this.message = 'Unsupported expression type: ' + expressionType + '.';
});
UnsupportedOperatorError = createErrorType('UnsupportedExpressionError', function (operatorName) {
  this.message = 'Unsupported operator: ' + operatorName + '.';
});
UnsupportedUnitError = createErrorType('UnsupportedExpressionError', function (unitName) {
  this.message = 'Unsupported unit: ' + unitName + '.';
});
InvalidArgumentsNumberError = createErrorType('InvalidArgumentsNumberError',
    function (operatorName, actualNumber, expectedNumber) {
      this.message = 'Invalid number of arguments for ' + operatorName + ': ' +
          actualNumber + ' (expected: ' + expectedNumber + ').';
    });
UnsupportedCoordinateSystemError = createErrorType('UnsupportedCoordinateSystemError', function (name) {
  this.message = 'Unsupported coordinate system: ' + name + '.';
});
module.exports = SparqlExpressionEvaluator;
module.exports.UnsupportedExpressionError = UnsupportedExpressionError;
module.exports.UnsupportedOperatorError = UnsupportedOperatorError;
module.exports.UnsupportedUnitError = UnsupportedUnitError;
module.exports.InvalidArgumentsNumberError = InvalidArgumentsNumberError;
