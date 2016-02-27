// Require Logic
var dropbox    = require('dropbox')
  , stream     = require('stream')
  , q          = require('q')
  , RSS        = require('rss')
  , FeedParser = require('feedparser')
  , _          = require('lodash')
;

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

        self.log('uploading chunk', this.receivedBuffersLength);
        this.client.resumableUploadStep(
            Buffer.concat(this.receivedBuffers, this.receivedBuffersLength)
            , this.cursor
            , function(err, _cursor) {
                self.log('uploaded chunk', self.file);
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
              .then(function() {
                  client.resumableUploadFinish(self.file, self.cursor, function(err, stat) {
                      return err
                        ? self.fail(err)
                        : self.complete(stat);
                  });
              })
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
           .then(function() {
              self.complete({
                  url: self.url
              });
           })
           .catch(function(err) {
               console.log('catch');
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
        console.log('addAndSave');

        return this.add.call(this, step, dexter, state)
          .then(this.write.bind(this))
          .catch(this.fail.bind(this));
    }
    /**
     * Creates a new rss entity
     *
     *  @param {DexterStep} step
     *  @param {Dexter} dexter
     */
    , create: function(step, dexter) {
        console.log('create');

        var title = step.input('feed_title').first()
          , desc  = step.input('feed_description').first()
          , site  = step.input('site_url').first()
          , rss   = new RSS({
                        title       : title,
                        description : desc,
                        site_url    : site
                    })
        ;

        return q({
            rss: rss
            , additionalItems: []
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
        console.log('read');

        //set a flag indicating data was read
        this.isRead = true;
        var data = results[0][0]
          , url  = results[1].url
        ;

        this.url = url;

        var s          = new stream.Readable()
          , feedparser = new FeedParser()
          , deferred   = q.defer()
          , items      = []
        ;


        // Create a readable stream out of the string
        s._read = function noop() {};
        s.push(data);
        s.push(null);

        // Pipe it to thefeedparser
        s.pipe(feedparser);

        //grab all the items
        feedparser.on('readable', function() {
            var stream = this
              , meta = this.meta
              , item;

            while( (item = stream.read() ) ) {
               items.push(item);
            }

            var rss = new RSS({
                title       : meta.title,
                description : meta.description,
                feed_url    : url,
                site_url    : meta.link
              })
            ;

            deferred.resolve({
                rss               : rss
                , additionalItems : items
            });
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
        console.log('add');

        var title   = step.input('item_title').first()
          , content = step.input('item_content').first()
          , link    = step.input('item_link').first()
          , rss     = state.rss
          , items   = state.additionalItems
        ;

        _.each(items, function(item) {
            rss.item({
                title       : item.title,
                description : item.description,
                url         : item.link
            });
        });

        //only add the item if we have a link
        if(link) {
            rss.item({
                title: title
                , description: content
                , url: link
                , date: (new Date()).toUTCString()
            });
        }

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
        console.log('write');

        return q.nfcall(this.client.writeFile.bind(this.client), this.file, state.rss.xml({indent:true}));
    }
};
