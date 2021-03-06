let Sharp = require('sharp');
let imagemin = require('imagemin');
let imageminJpegoptim = require('imagemin-jpegoptim');
let imageminPngquant = require('imagemin-pngquant');
let imageminSvgo = require('imagemin-svgo');
let gifsicle = require('gifsicle');

let execBuffer = require('exec-buffer');

let aws = require('aws-sdk');
let s3 = new aws.S3({
    apiVersion: '2006-03-01'
});

let mime = require('mime');

let promisify = require('es6-promisify').promisify;

let getObject = promisify(s3.getObject.bind(s3));
let putObject = promisify(s3.putObject.bind(s3));

let doOperations = (image, operations, callback) => {
    for (let operation of operations) {
        switch (operation.action) {
            case 'resize': {
                image.resize(
                    parseInt(operation.width, 10),
                    parseInt(operation.height, 10)
                );

                break;
            }

            case 'crop': {
                image.extract({
                    left: parseInt(operation.src_x, 10),
                    top: parseInt(operation.src_y, 10),
                    width: parseInt(operation.src_width, 10),
                    height: parseInt(operation.src_height, 10)
                });

                if (operation.destination_width || operation.destination_height) {
                    if (!operation.destination_width) {
                        operation.destination_width = parseInt(operation.src_width, 10);
                    }

                    if (!operation.destination_height) {
                        operation.destination_height = parseInt(operation.src_height, 10);
                    }

                    image.resize(
                        parseInt(operation.destination_width, 10),
                        parseInt(operation.destination_height, 10)
                    );
                }

                break;
            }

            case 'rotate': {
                image.rotate(360 - operation.angle);

                break;
            }

            case 'flip': {
                if (operation.horizontal) {
                    image.flip();
                }

                if (operation.vertical) {
                    image.flop();
                }

                break;
            }

            default: {
                callback(`Invalid operation action: ${operation.action}`);
            }
        }
    }
};

let getGifsicleArgs = (operations, callback) => {
    let args = ['--no-warnings', '--no-app-extensions', '--careful'];

    for (let operation of operations) {
        switch (operation.action) {
            case 'resize': {
                args.push(
                    `--resize=${parseInt(operation.width, 10)}x${parseInt(operation.height, 10)}`
                );

                break;
            }

            case 'crop': {
                args.push(
                    `--crop=${parseInt(operation.src_x, 10)},${parseInt(operation.src_y, 10)}+${parseInt(operation.src_width, 10)}x${parseInt(operation.src_height, 10)}`
                );

                if (operation.destination_width || operation.destination_height) {
                    if (!operation.destination_width) {
                        operation.destination_width = parseInt(operation.src_width, 10);
                    }

                    if (!operation.destination_height) {
                        operation.destination_height = parseInt(operation.src_height, 10);
                    }

                    args.push(
                        `--resize=${parseInt(operation.destination_width, 10)}x${parseInt(operation.destination_height, 10)}`
                    );
                }

                break;
            }

            case 'rotate': {
                let angle = Math.round(operation.angle / 90) * 90 % 360;

                if (angle) {
                    args.push(`--rotate-${angle > 0 ? 360 - angle : Math.abs(angle)}`);
                }

                break;
            }

            case 'flip': {
                if (operation.horizontal) {
                    args.push('--flip-vertical');
                }

                if (operation.vertical) {
                    args.push('--flip-horizontal');
                }

                break;
            }

            default: {
                callback(`Invalid operation action: ${operation.action}`);
            }
        }
    }

    return [...args, '--output', execBuffer.output, execBuffer.input];
};

exports.handler = ({
    bucket,
    filename,
    new_filename,
    quality = 80,
    operations = [],
    'return': output
}, context, callback) => getObject({
    Bucket: bucket,
    Key: filename
}).catch(err => callback(err))
    .then(({
        ACL: acl,
        Body: body,
        Metadata: meta
    }) => {
        if (mime.getType(new_filename) === 'image/gif') {
            return Promise.all([execBuffer({
                input: body,
                bin: gifsicle,
                args: getGifsicleArgs(operations, callback)
            }), acl, meta]);
        } else {
            let image = Sharp(body);

            doOperations(image, operations, callback);

            return Promise.all([promisify(image.toBuffer.bind(image))(), acl, meta]);
        }
    })
    .then(([buffer, acl, meta]) => Promise.all([imagemin.buffer(buffer, {
        plugins: [
            imageminJpegoptim({
                progressive: true,
                max: quality
            }),
            imageminPngquant({
                quality: [(quality - 10)/100, quality/100],
                speed: 4
            }),
            imageminSvgo({
                plugins: [{
                    removeViewBox: false
                }]
            })
        ]
    }), acl, meta]))
    .then(([body, acl, meta]) => {
        if (output === 'stream') {
            context.succeed(body.toString('base64'));
        } else {
            return putObject({
                Bucket: bucket,
                Key: new_filename,
                Body: body,
                ACL: acl,
                ContentType: mime.getType(new_filename),
                Metadata: meta
            });
        }
    })
    .catch(err => callback(err))
    .then(() => context.done());
