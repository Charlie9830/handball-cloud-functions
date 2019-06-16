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
import { DIRECTORY, USERS, TASKS, TASKLISTS, PROJECTLAYOUTS, INVITES, REMOTES, REMOTE_IDS, MEMBERS, TASKCOMMENTS, JOBS_QUEUE } from '../../../handball-libs/libs/pounder-firebase/paths';
import * as JobTypes from '../../../handball-libs/libs/pounder-firebase/jobTypes';
var { MultiBatch, BATCH_LIMIT } = require('firestore-multibatch');

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp({
    credential: admin.credential.applicationDefault(),
});

exports.performJob = functions.firestore.document('jobsQueue/{jobId}').onCreate((snapshot, context ) => {   
    return new Promise((resolve, reject) => {
        dispatchJobAsync(snapshot, context).then( () => {
            resolve();
        }).catch(error => {
            reject(error);
        })
    })
})

async function dispatchJobAsync(snapshot, context) {
    var job = snapshot.data();
    var type = job.type;
    var payload = job.payload;
    var jobId = context.params.jobId;

    // Remote TaskList Move.
    if (type === JobTypes.CLEANUP_REMOTE_TASKLIST_MOVE) {
        try {
            await cleanupRemoteTaskListMoveAsync(payload);
        }

        catch(error) {
            await completeJobAsync(jobId, 'failure', error);
            return;
        }

        await completeJobAsync(jobId, 'success', null);
        return;
    }

    // Local TaskList Move.
    else if (type === JobTypes.CLEANUP_LOCAL_TASKLIST_MOVE) {
        try {
            await cleanupLocalTaskListMoveAsync(payload);
        }
        
        catch {
            await completeJobAsync(jobId, 'failure', error);
            return;
        }

        await completeJobAsync(jobId, 'success', null);
        return;
    }

    else {
        // Unrecognized Job Type.
        throw "Unrecognized Job Type";
    }
}

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
        var newMemberRef = admin.firestore().collection('projects').doc(projectId).collection(MEMBERS).doc(targetUserId);

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
    batch.delete(admin.firestore().collection('projects').doc(projectId).collection(MEMBERS).doc(userId));
    batch.delete(admin.firestore().collection(USERS).doc(userId).collection('projectIds').doc(projectId));
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
    return admin.firestore().collection('projects').doc(projectId).collection(MEMBERS).get().then(snapshot => {
        var members = [];
        snapshot.forEach(doc => {
            members.push(doc.data());
        })

        var memberIndex = members.findIndex(item => {
            return item.userId === userId;
        })

        if (memberIndex !== -1) {
            var batch = admin.firestore().batch();
            var memberRef = admin.firestore().collection('projects').doc(projectId).collection(MEMBERS).doc(userId);
            batch.update(memberRef, { status: 'added' });

            var remoteIdsRef = admin.firestore().collection(USERS).doc(userId).collection('projectIds').doc(projectId);
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

    var memberRef = admin.firestore().collection('projects').doc(projectId).collection(MEMBERS).doc(userId);

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


async function cleanupRemoteTaskListMoveAsync(payload) {
    /*
        -> Collect completedTasks related to the Task List and COPY them to the Target Project. Save an Array of TaskIds
        -> Concat the CompletedTaskIds array together with the taskIds array from the Payload.
        -> Iterate through the taskIds, Copy Task Comments to the targetProject then Delete the original Task.
        -> Another Cloud Function will Trigger on Task Delete and cleanup comments from Original Project.
    
    EXPECTED PAYLOAD
        sourceProjectId               string
        targetProjectId               string
        taskListWidgetId              string
        taskIds                       []                                    Id's of Tasks belonging to the Task List.
        targetTasksRefPath            string (Document Reference Path);
        targetTaskListRefPath         string (Document Reference Path);
        sourceTasksRefPath            string (Document Reference Path);
        sourceTaskListRefPath         string (Document Reference Path); 
    */
        var requests = [];
        var batch = new MultiBatch(admin.firestore());

        var taskIds = payload.taskIds;
        var sourceProjectId = payload.sourceProjectId;
        var targetProjectId = payload.targetProjectId;
        var taskListWidgetId = payload.taskListWidgetId;
        var sourceTasksRef = admin.firestore().collection(payload.sourceTasksRefPath);
        var targetTasksRef = admin.firestore().collection(payload.targetTasksRefPath);
        var sourceTaskListRef = admin.firestore().doc(payload.sourceTaskListRefPath);

        // Copy Completed Tasks. Promise will resolve with an array of TaskIds that were moved.
        var completedTaskIds = await copyCompletedTasksToProjectAsync(sourceProjectId, targetProjectId, taskListWidgetId, sourceTasksRef, targetTasksRef);
            // Combine the TaskIds from the Job Payload (Moved by the Client)
            // and the TaskIds returned from copyCompletedTasksToProjectAsync (Copied by Server).
            var mergedTaskIds = [...taskIds, ...completedTaskIds];

            mergedTaskIds.forEach(taskId => {
                requests.push(sourceTasksRef.doc(taskId).collection(TASKCOMMENTS).get().then(snapshot => {
                    if (!snapshot.empty) {
                        // Iterate through Comments and add them to the new Location, then delete the Task from the old Location.
                        // Another cloud Function will kick in and delete the Task comments from the source location.
                        snapshot.forEach(doc => {
                            batch.set(targetTasksRef.doc(taskId).collection(TASKCOMMENTS).doc(doc.id), doc.data());
                            batch.delete(sourceTasksRef.doc(taskId));
                        })
                    }
                }))
            })

            // Delete the source Task List.
            batch.delete(sourceTaskListRef);

            await Promise.all(requests);
            await batch.commit();
            return;
}

async function copyCompletedTasksToProjectAsync(sourceProjectId, targetProjectId, taskListWidgetId, sourceTasksRef, targetTasksRef) {
    var completedTaskIds = [];
    var batch = new MultiBatch(admin.firestore());

    var snapshot = await sourceTasksRef.where("taskList", "==", taskListWidgetId).where("isComplete", "==", true).get();

    if (!snapshot.empty) {
        snapshot.forEach(doc => {
            completedTaskIds.push(doc.id);
            batch.set(targetTasksRef.doc(doc.id), { ...doc.data(), project: targetProjectId });
        })

        await batch.commit();
    }

    return completedTaskIds;
}

async function cleanupLocalTaskListMoveAsync(payload) {

    /*
        -> Collect completed Tasks and adjust their 'project' field to the Target Project Id.
    
    EXPECTED PAYLOAD
        targetProjectId               string
        taskListWidgetId              string
        sourceTasksRefPath            string
    */

    var targetProjectId = payload.targetProjectId;
    var taskListWidgetId = payload.taskListWidgetId;
    var tasksRef = admin.firestore().collection(payload.sourceTasksRefPath);

    var snapshot = await tasksRef.where("taskList", "==", taskListWidgetId).where("isComplete", "==", true).get();

    if (!snapshot.empty) {
        var batch = new MultiBatch(admin.firestore());

        snapshot.forEach(doc => {
            batch.update(doc.ref, { project: targetProjectId });
        })

        await batch.commit();
    }

    return;
}

function completeJobAsync(jobId, result, error) {
    if (result === 'success') {
        // Remove Job from the Queue.
        return admin.firestore().collection(JOBS_QUEUE).doc(jobId).delete();
    }

    else {
        // Job Failed. Leave Job in Queue and record Error.
        return admin.firestore().collection(JOBS_QUEUE).doc(jobId).update({ error: convertErrorToString(error) });
    }
}

function convertErrorToString(error) {
    if (typeof(error) === "string") {
        return error;
    }

    if (typeof(error) === "object") {
        if (error["message"] !== undefined) {
            return error.message;
        }

        else {
            return "Could not convert Error to String."
        }
    }

    return "convertErrorToString failed to convert the error.";
    
}
