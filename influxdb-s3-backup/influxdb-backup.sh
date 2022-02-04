#!/bin/bash
export S3_BUCKET=${S3_BUCKET}
# Check and set missing environment vars
: ${S3_BUCKET:?"S3_BUCKET env variable is required"}
: ${AWS_SECRET_ACCESS_KEY:?"AWS_SECRET_ACCESS_KEY env variable is required"}
: ${AWS_ACCESS_KEY_ID:?"AWS_ACCESS_KEY_ID env variable is required"}
if [[ -z ${S3_KEY_PREFIX} ]]; then
  export S3_KEY_PREFIX=""
else
  if [ "${S3_KEY_PREFIX: -1}" != "/" ]; then
    export S3_KEY_PREFIX="${S3_KEY_PREFIX}/"
  fi
fi

: ${DATABASE:?"DATABASE env variable is required"}
export BACKUP_PATH=${BACKUP_PATH:-/data/influxdb/backup}
export BACKUP_ARCHIVE_PATH=${BACKUP_ARCHIVE_PATH:-${BACKUP_PATH}.tgz}
export DATETIME=$(date "+%Y%m%d%H%M%S")

# Dump database to directory
echo "Backing up $DATABASE to $BACKUP_PATH"
if [ -d $BACKUP_PATH ]; then
  rm -rf $BACKUP_PATH
fi
mkdir -p $BACKUP_PATH
influxd backup -portable -database $DATABASE $BACKUP_PATH
if [ $? -ne 0 ]; then
  echo "Failed to backup $DATABASE to $BACKUP_PATH"
  exit 1
fi

# Compress backup directory
if [ -e $BACKUP_ARCHIVE_PATH ]; then
  rm -rf $BACKUP_ARCHIVE_PATH
fi
tar -cvzf $BACKUP_ARCHIVE_PATH $BACKUP_PATH

# Push backup file to S3
echo "Sending file to S3"
if aws s3 rm s3://${S3_BUCKET}/${S3_KEY_PREFIX}latest.tgz; then
  echo "Removed latest backup from S3"
else
  echo "No latest backup exists in S3"
fi
if aws s3 cp $BACKUP_ARCHIVE_PATH s3://${S3_BUCKET}/${S3_KEY_PREFIX}latest.tgz; then
  echo "Backup file copied to s3://${S3_BUCKET}/${S3_KEY_PREFIX}latest.tgz"
else
  echo "Backup file failed to upload"
  exit 1
fi
if aws s3api copy-object --copy-source ${S3_BUCKET}/${S3_KEY_PREFIX}latest.tgz --key ${S3_KEY_PREFIX}${DATETIME}.tgz --bucket $S3_BUCKET; then
  echo "Backup file copied to s3://${S3_BUCKET}/${S3_KEY_PREFIX}${DATETIME}.tgz"
else
  echo "Failed to create timestamped backup"
  exit 1
fi

echo "Done"
