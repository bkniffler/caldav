(function(module, ns) {

  var RequestErrors = ns.require('errors');

  /**
   * Creates a propfind request.
   *
   * @param {Caldav.Connection} connection connection details.
   * @param {Object} options options for propfind.
   */
  function CalendarHome(connection, options) {
    var key;

    if (typeof(options) === 'undefined') {
      options = {};
    }

    for (key in options) {
      if (Object.hasOwnProperty.call(options, key)) {
        this[key] = options[key];
      }
    }

    this.connection = connection;
  }

  function findProperty(name, data, single) {
    var url, results = [], prop;

    for (url in data) {
      if (Object.hasOwnProperty.call(data, url)) {
        if (name in data[url]) {
          prop = data[url][name];
          if (prop.status === '200') {
            results.push(data[url][name].value);
          }
        }
      }
    }

    if (!results.length)
      return false;

    if (typeof(single) !== 'undefined' && single) {
      return results[0];
    }

    return results;
  }

  CalendarHome.prototype = {

    Propfind: ns.require('request/propfind'),

    /**
     * @return {Caldav.Xhr} The underlying xhr request so that the caller
     *                      has a chance to abort the request.
     */
    _findPrincipal: function(url, callback) {
      var find = new this.Propfind(this.connection, {
        url: url
      });

      find.prop('current-user-principal');
      find.prop('principal-URL');

      return find.send(function(err, data) {
        var principal;

        if (err) {
          callback(err);
          return;
        }

        // some fairly dumb allowances
        principal =
          findProperty('current-user-principal', data, true) ||
          findProperty('principal-URL', data, true);

        if (!principal) {
          return callback(new Errors.InvalidEntrypoint(
            'both current-user-principal and principal-URL are missing'
          ));
        }

        // per http://tools.ietf.org/html/rfc6638 we get unauthenticated
        if ('unauthenticated' in principal) {
          return callback(
            new Errors.Authentication('caldav response is unauthenticated')
          );
        }

        // we might have both principal.href & unauthenticated
        if (principal.href) {
          return callback(null, principal.href);
        }

        callback(
          new Errors.InvalidEntrypoint('no useful location information found')
        );
      });
    },

    _findCalendarHome: function(url, callback) {
      var details = {};
      var find = new this.Propfind(this.connection, {
        url: url
      });

      find.prop(['caldav', 'calendar-home-set']);

      return find.send(function(err, data) {
        if (err) {
          callback(err);
          return;
        }

        details = {
          url: findProperty('calendar-home-set', data, true)
        };

        callback(null, details);
      });
    },

    /**
     * Starts request to find calendar home url
     *
     * @param {Function} callback node style where second argument
     *                            are the details of the home calendar.
     * @return {Caldav.Xhr} The underlying xhr request so that the caller
     *                      has a chance to abort the request.
     */
    send: function(callback) {
      var self = this;
      return self._findPrincipal(self.url, function(err, url) {

        if (!url) {
          callback(err);
          return;
        }

        self._findCalendarHome(url, function(err, details) {
          callback(err, details);
        });
      });
    }

  };

  module.exports = CalendarHome;

}.apply(
  this,
  (this.Caldav) ?
    [Caldav('request/calendar_home'), Caldav] :
    [module, require('../caldav')]
));
