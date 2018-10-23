    /* *************************************************
    |   BEWARE! Make sure you keep an eye on the       |
    |    webpack output Build size when you are        |
    |    importing here. You may have to update the    |
    |    webpack config externals regex to exclude     |
    |    large modules.                                |
    |                                                  |
    | **************************************************
    */
import { DirectoryStore, InviteStore, MemberStore } from '../../../handball-libs/libs/pounder-stores';
import { DIRECTORY, USERS, TASKS, TASKLISTS, PROJECTLAYOUTS, INVITES, REMOTES, REMOTE_IDS, MEMBERS, TASKCOMMENTS } from '../../../handball-libs/libs/pounder-firebase/paths';
var { MultiBatch, BATCH_LIMIT } = require('firestore-multibatch');

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp({
    credential: admin.credential.applicationDefault(),
});

exports.removeLocalOrphanedTaskComments = functions.firestore.document('users/{userId}/tasks/{taskId}').onDelete((snapshot, context ) => {
    var userId = context.params.userId;
    var taskId = context.params.taskId;

    var taskCommentsQuery = admin.firestore().collection(USERS).doc(userId).collection(TASKS).doc(taskId).collection(TASKCOMMENTS);
    return removeOrphanedTaskComments(taskCommentsQuery);
})

exports.removeRemoteOrphanedTaskComments = functions.firestore.document('remotes/{projectId}/tasks/{taskId}').onDelete((snapshot, context) => {
    var projectId = context.params.userId;
    var taskId = context.params.taskId;

    var taskCommentsQuery = admin.firestore().collection(REMOTES).doc(projectId).collection(TASKS).doc(taskId).collection(TASKCOMMENTS);

    return removeOrphanedTaskComments(taskCommentsQuery);
})

exports.removeUserFromDirectory = functions.auth.user().onDelete((user) => {
    return admin.firestore().collection(DIRECTORY).doc(user.email).delete().then(() => {
        // Complete.
    })
})

exports.removeLocalTasksOrphanedFromTaskLists = functions.firestore.document('users/{userId}/taskLists/{taskListId}').onDelete((snapshot, context) => {
    var userId = context.params.userId;
    var taskListId = context.params.taskListId;

    var taskQuery = admin.firestore().collection(USERS).doc(userId).collection(TASKS).where('taskList', '==', taskListId);

    return removeOrphanTasksAsync(taskQuery);
})

exports.removeRemoteTasksOrphanedFromTaskLists = functions.firestore.document('remotes/{projectId}/taskLists/{taskListId}').onDelete((snapshot, context) => {
    var projectId = context.params.projectId;
    var taskListId = context.params.taskListId;

    var tasksQuery = admin.firestore().collection(REMOTES).doc(projectId).collection(TASKS).where('taskList', '==', taskListId);

    return removeOrphanTasksAsync(tasksQuery);
})

function removeOrphanedTaskComments(query) {
    return new Promise((resolve, reject) => {
        query.get().then(snapshot => {
            if (snapshot.empty !== true) {
                var batch = new MultiBatch(admin.firestore());

                snapshot.forEach(doc => {
                    batch.delete(doc.ref);
                })

                batch.commit().then( () => {
                    resolve();
                }).catch(error => {
                    reject(error);
                })
            }

            else {
                resolve();
            }
        })
    })
}

function removeOrphanTasksAsync(query) {
    return new Promise((resolve, reject) => {
        var relatedTaskRefs = [];
        query.get().then(snapshot => {
            if (snapshot.empty !== true) {
                snapshot.forEach(doc => {
                    relatedTaskRefs.push(doc.ref);
                })

                batchDeleteTaskRefsAsync(relatedTaskRefs).then(() => {
                    resolve();
                }).catch(error => {
                    reject(error);
                })
            }

            else {
                resolve();
            }
        })
    })
}

function batchDeleteTaskRefsAsync(taskRefs) {
    return new Promise((resolve, reject) => {
        var batch = new MultiBatch(admin.firestore())

        taskRefs.forEach(ref => {
            batch.delete(ref);
        })

        batch.commit().then(() => {
            // Success.
            resolve();
        }).catch(error => {
            reject(error);
        })
    })
}

exports.getRemoteUserData = functions.https.onCall((data, context) => {
    var targetEmail = data.targetEmail;

    // Check if the user Exists.
    return admin.firestore().collection(DIRECTORY).doc(targetEmail).get().then(doc => {
        if (doc.exists) {
            // User has been Found.
            return {
                status: 'user found',
                userData: doc.data(), 
            }
        }

        else {
            // User doesn't exist.
            return { 
                status: 'user not found',
                userData: {},
            }
        }
    })
})

exports.sendProjectInvite = functions.https.onCall((data, context) => {
    var projectName = data.projectName;
    var sourceEmail = data.sourceEmail;
    var sourceDisplayName = data.sourceDisplayName;
    var projectId = data.projectId;
    var targetUserId = data.targetUserId;
    var targetDisplayName = data.targetDisplayName;
    var targetEmail = data.targetEmail;
    var sourceUserId = context.auth.uid;
    var role = data.role;

    var invite = new InviteStore(projectName, targetUserId, sourceUserId, sourceEmail, sourceDisplayName, projectId, role);

    var inviteRef = admin.firestore().collection(USERS).doc(targetUserId).collection(INVITES).doc(projectId);
    return inviteRef.set(Object.assign({}, invite)).then(() => {
        // Invite Sent. Add User to members collection of Target Project.
        var newMember = new MemberStore(targetUserId, projectId, targetDisplayName, targetEmail, 'pending', role);
        var newMemberRef = admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).doc(targetUserId);

        return newMemberRef.set(Object.assign({}, newMember)).then(() => {
            return { status: 'complete' }
        }).catch(error => {
            return {
                status: 'error',
                error: 'Error while setting user into members: ' + error.message,
            }
        })

    }).catch(error => {
        return {
            status: 'error',
            error: error.message
        }
    })
})

exports.kickUserFromProject = functions.https.onCall((data, context) => {
    var projectId = data.projectId;
    var userId = data.userId;

    var batch = admin.firestore().batch();
    batch.delete(admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).doc(userId));
    batch.delete(admin.firestore().collection(USERS).doc(userId).collection(REMOTE_IDS).doc(projectId));
    batch.delete(admin.firestore().collection(USERS).doc(userId).collection(INVITES).doc(projectId));

    return batch.commit().then( () => {
        return { status: 'complete' }
    }).catch(error => {
        return {
            status: 'error',
            message: 'Error occured while Kicking user: ' + error.message
        }
    })
})

exports.kickAllUsersFromProject = functions.https.onCall((data, context) => {
    var projectId = data.projectId;
    return admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).get().then(snapshot => {
        if (snapshot.empty !== true) {
            // Build a Batch.
            var batch = admin.firestore().batch();
            snapshot.forEach(doc => {
                batch.delete(admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).doc(doc.id));
                batch.delete(admin.firestore().collection(USERS).doc(doc.id).collection(REMOTE_IDS).doc(projectId));
                batch.delete(admin.firestore().collection(USERS).doc(doc.id).collection(INVITES).doc(projectId));
            })

            // Commit.
            return batch.commit().then(() => {
                return { status: 'complete' }
            }).catch(error => {
                return {
                    status: 'error',
                    message: 'Error occured while Kicking user: ' + error.message
                }
            })
        }

        else {
            return { 
                status: 'error',
                message: 'Project has no contributors to kick.' }
        }
    })

    var batch = admin.firestore().batch();
    batch.delete(admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).doc(userId));
    batch.delete(admin.firestore().collection(USERS).doc(userId).collection(REMOTE_IDS).doc(projectId));
    batch.delete(admin.firestore().collection(USERS).doc(userId).collection(INVITES).doc(projectId));

    
})

exports.acceptProjectInvite = functions.https.onCall((data, context) => {
    var projectId = data.projectId;
    var userId = context.auth.uid;

    // Check that the Current user still exists in the Remote Project's Member Collection.
    return admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).get().then(snapshot => {
        var members = [];
        snapshot.forEach(doc => {
            members.push(doc.data());
        })

        var memberIndex = members.findIndex(item => {
            return item.userId === userId;
        })

        if (memberIndex !== -1) {
            var batch = admin.firestore().batch();
            var memberRef = admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).doc(userId);
            batch.update(memberRef, { status: 'added' });

            var remoteIdsRef = admin.firestore().collection(USERS).doc(userId).collection(REMOTE_IDS).doc(projectId);
            batch.set(remoteIdsRef, { projectId: projectId });

            return batch.commit().then(() => {
                return { status: 'complete' }
            }).catch(error => {
                return {
                    status: 'error',
                    message: 'Error occured while accepting project invite. ' + error.message,
                }
            })
        }
    }).catch(error => {
        return {
            status: 'error',
            message: 'Error occured while validating project invite. ' + error.message,
        }
    })
})

exports.denyProjectInvite = functions.https.onCall((data, context) => {
    var projectId = data.projectId;
    var userId = context.auth.uid;

    var memberRef = admin.firestore().collection(REMOTES).doc(projectId).collection(MEMBERS).doc(userId);

    return memberRef.update({ status: "rejected invite" }).then( () => {
        return { status: 'complete' };
    }).catch( error => {
        return {
            status: 'error',
            message: 'Error occured whilst denying project invite.' + error.message,
        }
    })
})

exports.removeRemoteProject = functions.https.onCall((data, context) => {
    var projectId = data.projectId;
    var userId = context.auth.uid;

    // Delete Project
    var requests = [];
    var projectLayoutRefs = [];
    var taskListRefs = [];
    var taskRefs = [];
    var memberIds = [];
    var memberRefs = [];
    var initialRef = admin.firestore().collection(REMOTES).doc(projectId);

    // Project Layouts.
    requests.push(initialRef.collection(PROJECTLAYOUTS).get().then( snapshot => {
        snapshot.forEach(doc => {
            projectLayoutRefs.push(doc.ref);
        })
    }))

    // TaskLists.
    requests.push(initialRef.collection(TASKLISTS).get().then( snapshot => {
        snapshot.forEach(doc => {
            taskListRefs.push(doc.ref);
        })
    }))

    // Tasks.
    requests.push(initialRef.collection(TASKS).get().then( snapshot => {
        snapshot.forEach(doc => {
            taskRefs.push(doc.ref);
        })
    }))

    // Members
    requests.push(initialRef.collection(MEMBERS).get().then( snapshot => {
        snapshot.forEach(doc => {
            memberRefs.push(doc.ref);
            memberIds.push(doc.id);
        })
    }))

    return Promise.all(requests).then(() => {
        // Build Batch.
        var batch = new MultiBatch(admin.firestore());

        // Project Layouts
        projectLayoutRefs.forEach(ref => {
            batch.delete(ref);
        })

        // Task Lists.
        taskListRefs.forEach(ref => {
            batch.delete(ref);
        })

        // Tasks
        taskRefs.forEach(ref => {
            batch.delete(ref);
        })

        // Members
        memberRefs.forEach(ref => {
            batch.delete(ref);
        })

        memberIds.forEach(id => {
            // Delete the RemoteId References of Members.
            var remoteIdRef = admin.firestore().collection(USERS).doc(id).collection(REMOTE_IDS).doc(projectId);
            batch.delete(remoteIdRef);

            // Remove any unanswered Invites. Just in case.
            var inviteRef = admin.firestore().collection(USERS).doc(id).collection(INVITES).doc(projectId);
            batch.delete(inviteRef);
        })

        // Top Level Project Data.
        batch.delete(initialRef);

        // Execute the Batch.
        return batch.commit().then(() => {
            return { status: 'complete' }
        }).catch(error => {
            return {
                status: 'error',
                message: error.message
            }
        })
    })  
    
})


