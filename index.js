// Require Logic
var dropbox    = require('dropbox')
  , stream     = require('stream')
  , q          = require('q')
  , RSS        = require('podcast')
  , FeedParser = require('feedparser')
  , _          = require('lodash')
  , debug
;

function log() {
    if(debug)
        console.log.apply(console, arguments);
}

module.exports = {
    /**
     *  Inits the class
     */
    init: function() {
        this.receivedBuffers = [];
        this.receivedBuffersLength = 0;
        this.partSizeThreshhold = 5242880;
    }

    /**
     *  Cache contents
     *
     *  @param {Buffer} incomingBuffer - chunk to add to our cache
     */
    , absorbBuffer: function(incomingBuffer) {
        this.receivedBuffers.push(incomingBuffer);
        this.receivedBuffersLength += incomingBuffer.length;
    }
    
    /**
     *  Upload cache contents
     */
    , upload: function() {
        var self     = this
          , deferred = q.defer()
        ;

        if(!this.receivedBuffersLength) return deferred.resolve();

        log('uploading chunk', this.receivedBuffersLength);
        this.client.resumableUploadStep(
            Buffer.concat(this.receivedBuffers, this.receivedBuffersLength)
            , this.cursor
            , function(err, _cursor) {
                log('uploaded chunk', self.file);
                self.cursor = _cursor;
                return err
                   ? deferred.reject(err)
                   : deferred.resolve()
                ;
            }
        );

        this.receivedBuffers.length = 0;
        this.receivedBuffersLength = 0;

        return deferred.promise;
    }

    /**
     * The main entry point for the Dexter module
     *
     * @param {AppStep} step Accessor for the configuration for the step using this module.  Use step.input('{key}') to retrieve input data.
     * @param {AppData} dexter Container for all data used in this workflow.
     */
    , run: function(step, dexter) {
        var self     = this
          , file     = step.input('file').first()
          , writable = new stream.Writable({ highWaterMark: 4194304 })
          , client   = new dropbox.Client({token: dexter.provider('dropbox').credentials('access_token')})
          , cursor   = null
        ;

        //allow debugging the module
        debug = !!dexter.environment('debug');

        this.client   = client;
        this.file     = file;
        this.writable = writable;

        writable._write = function(chunk, encoding, next) {
            self.absorbBuffer(chunk);

            if(self.receivedBuffersLength < self.partSizeThreshhold) {
                next();
            } else {
                self.upload()
                  .then(next)
                  .catch(self.fail.bind(self));
            }
        };


        // Handle errors.
        writable.on('error', function (err) {
            console.error(err);
            self.fail(err);
        });

        // Handle the last chunk and complete the task
        writable.on('finish', function (details) {
            self
              .upload()
              .then(q.nbind(client.resumableUploadStep, client, self.file, self.cursor))
              .catch(self.fail.bind(self));
        });

        /**
         *  The chain of commands to read/create the stream, add to it and then send it back
         */
        q.all([
                q.nfcall(client.readFile.bind(client), file),
                q.nfcall(client.makeUrl.bind(client), file, { downloadHack: true })
            ])
           .then(this.read.bind(this, step, dexter))
           .then(this.addAndSave.bind(this, step, dexter))
           .catch(function(err) {
               log('catch');
               if(!self.isRead) {
                   self
                     .create(step, dexter)
                     .then(self.addAndSave.bind(self, step, dexter))
                     .catch(self.fail.bind(self))
                   ;
               } else {
                   self.fail(err);
               }
           })
        ;
    }
    /**
     *  Adds any additional items to the feed and resaves it
     *
     *  @param {DexterStep} step
     *  @param {Dexter} dexter
     *  @param {Object} state - state throughout the promise chain 
     *                  { rss: <rss>, additionalItems: [ { title: 'title', description: 'description' }, ...]
     */
    , addAndSave: function(step, dexter, state) {
        log('addAndSave');

        return this.add.call(this, step, dexter, state)
          .then(this.write.bind(this))
          .then(this.done.bind(this))
          .catch(this.fail.bind(this));
    }
    /**
     * Creates a new rss entity
     *
     *  @param {DexterStep} step
     *  @param {Dexter} dexter
     */
    , create: function(step, dexter) {
        log('create');

        var title = step.input('feed_title').first()
          , desc  = step.input('feed_description').first()
          , site  = step.input('site_url').first()
          , rss   = new RSS({
              title          : title,
              description    : desc,
              pubDate        : (new Date()).toUTCString(),
              language       : 'en',
              site_url       : 'https://rundexter.com',
              image_url      : 'https://rundexter.com/images/favicons/android-chrome-192x192.png',
              author         : 'Dexter',
              itunesAuthor   : 'Dexter',
              itunesSummary  : 'Automated playlist generated by Dexter',
              itunesExplicit : false,
              itunesDuration : 12345,
              itunesSubtitle : 'Automated playlist generated by Dexter',
              itunesImage    : 'https://rundexter.com/images/favicons/android-chrome-192x192.png',
          })
        ;

        return q({
            rss               : rss
            , additionalItems : []
        });
    }
    /**
     *  Processes a feed XML file
     *
     *  @param {DexterStep} step
     *  @param {Dexter} dexter
     *  @param {String} data - the contents of the feed xml
     */
    , read: function(step, dexter, results) {
        log('read');

        //set a flag indicating data was read
        this.isRead = true;
        var data       = results[0][0]
          , url        = results[1].url
          , s          = new stream.Readable()
          , feedparser = new FeedParser()
          , deferred   = q.defer()
          , items      = []
          , self       = this
          , rss
        ;

        // Create a readable stream out of the string
        s._read = function noop() {};
        s.push(data);
        s.push(null);

        // Pipe it to thefeedparser
        s.pipe(feedparser);

        feedparser.on('meta', function(meta) {
            rss = {
                title       : !meta.title || meta.title.match(/^untitled/i) ? step.input('feed_title').first() : meta.title,
                description : !meta.description || meta.description.match(/^untitled/i) ? step.input('feed_description').first() : meta.title,
                feed_url    : url,
                site_url    : 'https://rundexter.com',
                pubDate     : meta.pubDate || (new Date()).toUTCString(),
                language    : 'en',
                image_url   : 'https://rundexter.com/images/favicons/android-chrome-192x192.png',
                author      : 'Dexter',
                itunesSummary  : 'Automated playlist generated by Dexter',
                itunesAuthor: 'Dexter',
                itunesExplicit: false,
                itunesDuration: 12345,
                itunesSubtitle: 'Automated playlist generated by Dexter',
                itunesImage: 'https://rundexter.com/images/favicons/android-chrome-192x192.png',
            };


            rss = new RSS(rss);
        });

        feedparser.on('end', function() {
            log('end');

            self.state = {
                rss               : rss
                , additionalItems : items
                , feed_url        : url
            };

            deferred.resolve(self.state);
        });

        //grab all the items
        feedparser.on('readable', function() {
            log('readable');

            var stream = this
              , meta = this.meta
              , item;

            while( (item = stream.read() ) ) {
               log('item');
               items.push(item);
            }
        });

        //handle errors
        feedparser.on('error', deferred.reject.bind(deferred));

        return deferred.promise;
    }

    /**
     *  Processes a feed XML file
     *
     *  @param {DexterStep} step
     *  @param {Dexter} dexter
     *  @param {Object} state - state throughout the promise chain 
     *                  { rss: <rss>, additionalItems: [ { title: 'title', description: 'description' }, ...]
     */
    , add: function(step, dexter, state) {
        log('add');

        var links    = step.input('item_link')
          , rss     = state.rss
          , items   = state.additionalItems
        ;

        //make sure the feed has a link back
        if(state.feed_url) rss.feed_url = state.feed_url;


        _.each(links, function(link, idx) {
            var title   = step.input('item_title')[idx]
              , content = step.input('item_content')[idx]
              , length  = step.input('item_length')[idx]
              , type    = step.input('item_type')
              , newItem
            ;

            type = type.length > 1 
              ? type[idx]
              : type[0]
            ;

            newItem = {
                title         : title
                , description : content
                , url         : link
                , date        : (new Date()).toUTCString()
                , enclosure   : {
                    url      : link
                    , type   : type
                    , size   : parseInt(length)
                }
            };

            log('newItem', newItem);

            rss.item(newItem);
        });


         // Add the existing items back
        _.each(items, function(item) {
            rss.item({
                title          : item.title,
                description    : item.description,
                url            : item.link,
                author         : 'Dexter',
                date           : item.date || (new Date()).toUTCString(),
                enclosure      : {
                    url: _.get(item, 'enclosures[0].url'),
                    size: _.get(item, 'enclosures[0].length'),
                    type: _.get(item, 'enclosures[0].type')
                },
                itunesAuthor   : 'Dexter',
                itunesExplicit : false,
                itunesDuration : 12345,
                itunesSubtitle : 'Automated playlist generated by Dexter',
                itunesImage    : 'https://rundexter.com/images/favicons/android-chrome-192x192.png'
            });
        });

        return q(state);
    }
    /**
     * Write the xml file to dropbox
     *  @param {Object} state - state throughout the promise chain normall looks something like 
     *                  ```
     *                  { rss: <rss>, additionalItems: [ { title: 'title', description: 'description' }, ...]
     *                  ```
     */
    , write: function(state) {
        log('write');

        return q.nfcall(this.client.writeFile.bind(this.client), this.file, state.rss.xml({indent:true}));
    }
    , done: function() {
       log('done', _.keys(this.state));
       var url = _.get(this, 'state.feed_url')
         , self = this
         , client = self.client
       ;

       if(!url) {
           q.nfcall(client.makeUrl.bind(client), self.file, { downloadHack: true })
                .then(function(result) {
                    self.complete({ url: result.url});
                })
                .catch(this.fail.bind(this))
                .done()
           ;
       } else {
           this.complete({ url: url});
       }
    }
};
